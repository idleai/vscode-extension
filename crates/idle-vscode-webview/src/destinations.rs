//! Read-only destinations while the shared editing and execution surfaces evolve.

use app_core::{ViewModel, configuration, resources, workspace::NavigationSection};
use dioxus::prelude::*;

pub(crate) fn destination(view: &ViewModel) -> Option<Element> {
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
        NavigationSection::ComputeHosts | NavigationSection::ModelProviders => Some(
            rsx! { ResourceDirectory { view: view.resources.clone(), hosts: view.workspace.section == NavigationSection::ComputeHosts } },
        ),
        NavigationSection::Settings => Some(
            rsx! { ConfigurationDocument { title: "Settings", editor: view.configuration.settings.clone() } },
        ),
        NavigationSection::AgentRules => Some(
            rsx! { ConfigurationDocument { title: "Agent Rules", editor: view.configuration.agent_rules.clone() } },
        ),
        NavigationSection::Workspace
        | NavigationSection::Sessions
        | NavigationSection::Projections
        | NavigationSection::Activity => None,
    }
}

#[component]
fn ResourceDirectory(view: resources::ViewModel, hosts: bool) -> Element {
    let entries: Vec<(String, String, resources::ResourceAvailability)> = if hosts {
        view.hosts
            .iter()
            .filter(|entry| {
                view.selected_host
                    .as_ref()
                    .is_none_or(|id| id == &entry.host.id)
            })
            .map(|entry| {
                (
                    entry.host.id.clone(),
                    entry.host.name.clone(),
                    entry.availability,
                )
            })
            .collect()
    } else {
        view.providers
            .iter()
            .filter(|entry| {
                view.selected_provider
                    .as_ref()
                    .is_none_or(|id| id == &entry.provider.id)
            })
            .map(|entry| {
                (
                    entry.provider.id.clone(),
                    entry.provider.name.clone(),
                    entry.availability,
                )
            })
            .collect()
    };
    rsx! {
        section { class: "idle-stack", aria_label: "Resource directory",
            h2 { if hosts { "Compute hosts" } else { "Model providers" } }
            match &view.load {
                resources::ResourceLoadState::Failed(error) => rsx! { p { role: "alert", "{error.message}" } },
                resources::ResourceLoadState::Loading => rsx! { p { role: "status", "Loading resources…" } },
                resources::ResourceLoadState::Suspended => rsx! { p { role: "status", "Resource connection interrupted." } },
                resources::ResourceLoadState::Idle => rsx! { p { "Select a connected workspace to load resources." } },
                resources::ResourceLoadState::Ready => rsx! {},
            }
            for (id, name, availability) in &entries {
                article { key: "{id}", h3 { "{name}" } p { "{availability:?}" } }
            }
            if entries.is_empty() && view.load == resources::ResourceLoadState::Ready { p { "No resources are published in this workspace." } }
            p { "Runtime actions are unavailable until a runtime is connected." }
        }
    }
}

#[component]
fn ConfigurationDocument(title: String, editor: configuration::ConfigurationEditorView) -> Element {
    rsx! {
        section { class: "idle-stack", aria_label: title.clone(),
            h2 { "{title}" }
            match &editor.load {
                configuration::ConfigurationLoadState::Failed(error) => rsx! { p { role: "alert", "{error.message}" } },
                configuration::ConfigurationLoadState::Loading | configuration::ConfigurationLoadState::Refreshing => rsx! { p { role: "status", "Loading document…" } },
                configuration::ConfigurationLoadState::Suspended => rsx! { p { role: "status", "Document connection interrupted." } },
                configuration::ConfigurationLoadState::Idle => rsx! { p { "Select a connected workspace to load this document." } },
                configuration::ConfigurationLoadState::Ready => rsx! {},
            }
            if let Some(record) = editor.current {
                p { "Revision {record.revision}" }
                pre { class: "idle-configuration-document", code { "{record.value.json}" } }
            } else if editor.load == configuration::ConfigurationLoadState::Ready { p { "This document has not been created." } }
            p { "This document is read-only." }
        }
    }
}
