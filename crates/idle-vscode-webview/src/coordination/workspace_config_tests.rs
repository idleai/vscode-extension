use super::{
    Event, Runtime, Value, configuration, json, native, resources, settle, snapshot, start,
};

fn replace(runtime: &mut Runtime, event: Event, snapshot: &Value) {
    let calls = runtime.dispatch(event).unwrap();
    assert!(!calls.is_empty(), "refresh must read the native snapshot");
    for call in calls {
        assert_eq!(call.method, "app.coordination");
        let _calls = runtime.receive(&call.id, Ok(native(snapshot))).unwrap();
    }
}

fn resource_snapshot(owner: &str, revision: &str, position: &str) -> Value {
    let mut data = snapshot("one");
    *data.pointer_mut("/as_of/position").unwrap() = json!(position);
    let declared = owner.starts_with("configured:");
    let health = if declared {
        json!({"availability":"unknown","observed_at":"0","valid_until":"1"})
    } else {
        json!({"availability":"available","observed_at":"900","valid_until":"2000"})
    };
    *data.get_mut("hosts").unwrap() = json!([{"revision":revision, "value":{
        "id":"workstation", "name":"Development host", "owner":owner,
        "capabilities":[], "routes":[], "health":health,
    }}]);
    *data.get_mut("providers").unwrap() = json!([{"revision":revision, "value":{
        "id":"local", "name":"Local models", "owner":owner,
        "kind":{"kind":"local", "host_id":"workstation", "runtime_id":if declared {"unconnected"} else {"runtime"}},
        "routes":[], "health":health,
    }}]);
    data
}

#[test]
fn native_declarations_and_publications_keep_resource_revisions() {
    let (mut runtime, calls) = start();
    let _waiting = settle(&mut runtime, calls);
    for (owner, revision, position) in [
        ("configured:workspace", "2", "9007199254740994"),
        ("local-contributor:test", "4", "9007199254740995"),
        ("configured:workspace", "5", "9007199254740996"),
        ("local-contributor:test", "6", "9007199254740997"),
    ] {
        let data = resource_snapshot(owner, revision, position);
        replace(
            &mut runtime,
            Event::Resources(resources::Event::Refresh),
            &data,
        );
        let view = runtime.view().resources;
        assert_eq!(view.load, resources::ResourceLoadState::Ready, "{view:?}");
        let host = &view.hosts.first().unwrap().host;
        let provider = &view.providers.first().unwrap().provider;
        assert_eq!(host.owner, owner);
        assert_eq!(provider.owner, owner);
        assert_eq!(host.revision, revision.parse::<u64>().unwrap());
        assert_eq!(provider.revision, revision.parse::<u64>().unwrap());
        assert!(
            view.hosts.first().unwrap().actions.is_empty(),
            "discovery never connects a runtime"
        );
        if owner.starts_with("configured:") {
            assert_eq!(
                view.hosts.first().unwrap().availability,
                resources::ResourceAvailability::Unknown
            );
            assert_eq!(
                view.providers.first().unwrap().availability,
                resources::ResourceAvailability::Unknown
            );
        }
    }
    let mut conflicting = resource_snapshot("local-contributor:test", "6", "9007199254740997");
    *conflicting.pointer_mut("/hosts/0/value/name").unwrap() =
        json!("Changed without advancing the resource revision");
    replace(
        &mut runtime,
        Event::Resources(resources::Event::Refresh),
        &conflicting,
    );
    assert!(
        matches!(
            runtime.view().resources.load,
            resources::ResourceLoadState::Failed(_)
        ),
        "resource ordering must still reject changed values at an already confirmed revision"
    );
}

#[test]
fn deleted_configuration_resets_clean_editors_and_preserves_draft_conflicts() {
    for document in [
        configuration::ConfigurationDocument::Settings,
        configuration::ConfigurationDocument::AgentRules,
    ] {
        for dirty in [false, true] {
            let (mut runtime, calls) = start();
            let _waiting = settle(&mut runtime, calls);
            let mut data = snapshot("one");
            *data.get_mut("agent_rules").unwrap() = data.get("settings").unwrap().clone();
            replace(
                &mut runtime,
                Event::Configuration(configuration::Event::Refresh),
                &data,
            );
            if dirty {
                let _calls = runtime
                    .dispatch(Event::Configuration(configuration::Event::Edit {
                        document,
                        json: r#"{"unsaved":true}"#.into(),
                    }))
                    .unwrap();
            }
            let key = match document {
                configuration::ConfigurationDocument::Settings => "settings",
                configuration::ConfigurationDocument::AgentRules => "agent_rules",
            };
            *data.get_mut(key).unwrap() =
                json!({"revision":"9007199254740994", "value":{"schema_version":1,"json":"{}"}});
            *data.pointer_mut("/as_of/position").unwrap() = json!("9007199254740994");
            replace(
                &mut runtime,
                Event::Configuration(configuration::Event::Refresh),
                &data,
            );
            let view = runtime.view().configuration;
            let editor = match document {
                configuration::ConfigurationDocument::Settings => view.settings,
                configuration::ConfigurationDocument::AgentRules => view.agent_rules,
            };
            assert_eq!(editor.load, configuration::ConfigurationLoadState::Ready);
            assert_eq!(editor.current.as_ref().unwrap().value.json, "{}");
            assert_eq!(editor.conflict, dirty);
            assert_eq!(
                editor.draft.json,
                if dirty { r#"{"unsaved":true}"# } else { "{}" }
            );
            if dirty {
                assert!(
                    !editor
                        .actions
                        .contains(&configuration::ConfigurationEditorAction::Save)
                );
                let _calls = runtime
                    .dispatch(Event::Configuration(configuration::Event::Rebase {
                        document,
                        reviewed_revision: Some(9_007_199_254_740_994),
                    }))
                    .unwrap();
                let calls = runtime
                    .dispatch(Event::Configuration(configuration::Event::Save {
                        document,
                        request: configuration::ConfigurationRequest {
                            request_id: "recreate".into(),
                            expires_at_ms: 2000,
                        },
                    }))
                    .unwrap();
                let call = calls
                    .iter()
                    .find(|call| call.method == "app.coordination")
                    .unwrap();
                let command: Value =
                    serde_json::from_str(call.params.get("command").unwrap().as_str().unwrap())
                        .unwrap();
                assert_eq!(
                    command.pointer("/data/body/data/change/expected/value"),
                    Some(&json!("9007199254740994"))
                );
            }
        }
    }
}
