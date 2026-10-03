//! Shared workspace destinations composed through app-core actions.

use app_core::{ViewModel, configuration, workspace::NavigationSection};
use dioxus::prelude::*;

pub(crate) fn destination(
    view: &ViewModel,
    onaction: EventHandler<app_core::Event>,
    onsave: EventHandler<configuration::ConfigurationDocument>,
    onexecute: EventHandler<app_core::resources::ResourceMutation>,
) -> Option<Element> {
    match view.workspace.section {
        NavigationSection::Members => Some(rsx! {
            section { class: "idle-stack", aria_label: "Workspace users",
                h2 { "Users" }
                for user in &view.workspace.members {
                    article { key: "{user.member.contributor_id}",
                        h3 { "{user.member.display_name}" }
                        p { "{user.member.role:?} · {user.presence:?}" }
                    }
                }
                if view.workspace.members.is_empty() { p { "No users are available." } }
            }
        }),
        NavigationSection::ComputeHosts | NavigationSection::ModelProviders => {
            Some(rsx! { web_ui::resources::ResourceDirectory {
                view: view.resources.clone(), hosts: view.workspace.section == NavigationSection::ComputeHosts,
                onaction: move |event| onaction.call(app_core::Event::Resources(event)),
                onexecute,
            } })
        }
        NavigationSection::Settings => Some(rsx! { web_ui::configuration::ConfigurationEditor {
            id: "idle-settings", view: view.configuration.clone(), document: configuration::ConfigurationDocument::Settings,
            onaction: move |event| onaction.call(app_core::Event::Configuration(event)), onsave,
        } }),
        NavigationSection::AgentRules => Some(rsx! { web_ui::configuration::ConfigurationEditor {
            id: "idle-agent-rules", view: view.configuration.clone(), document: configuration::ConfigurationDocument::AgentRules,
            onaction: move |event| onaction.call(app_core::Event::Configuration(event)), onsave,
        } }),
        NavigationSection::Workspace
        | NavigationSection::Sessions
        | NavigationSection::Projections
        | NavigationSection::Activity => None,
    }
}
