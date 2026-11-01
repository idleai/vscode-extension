//! Document composition; semantic state and rendering stay in the shared crates.

use dioxus::prelude::*;
use web_ui::assembly::{Surface, WorkspaceSurface};

/// Mount one persistent application and its disposable host message listener.
#[component]
pub fn App() -> Element {
    let revision = use_signal(|| 0_u64);
    let mut error = use_signal(|| None::<String>);
    let _revision = *revision.read();
    #[cfg(target_arch = "wasm32")]
    let connection = use_hook(
        || match crate::connection::Connection::new(revision, error) {
            Ok(connection) => Some(connection),
            Err(message) => {
                error.set(Some(message));
                None
            }
        },
    );
    #[cfg(target_arch = "wasm32")]
    let (view, capabilities, now_ms, session_forms) = connection.as_ref().map_or_else(
        || {
            (
                app_core::ViewModel::default(),
                web_ui::host::HostCapabilities::new(web_ui::host::HostKind::VsCode),
                None,
                web_ui::sessions::SessionForms::default(),
            )
        },
        |connection| {
            let runtime = connection.runtime.borrow();
            (
                runtime.view(),
                runtime.capabilities(),
                runtime.now_ms(),
                runtime.session_forms(),
            )
        },
    );
    #[cfg(not(target_arch = "wasm32"))]
    let runtime =
        use_hook(|| std::rc::Rc::new(std::cell::RefCell::new(crate::adapters::Runtime::default())));
    #[cfg(not(target_arch = "wasm32"))]
    let (view, capabilities, now_ms, session_forms) = (
        runtime.borrow().view(),
        runtime.borrow().capabilities(),
        runtime.borrow().now_ms(),
        runtime.borrow().session_forms(),
    );
    #[cfg(target_arch = "wasm32")]
    let form_connection = connection.clone();
    #[cfg(target_arch = "wasm32")]
    let save_connection = connection.clone();
    #[cfg(target_arch = "wasm32")]
    let link_connection = connection.clone();
    #[cfg(not(target_arch = "wasm32"))]
    let form_runtime = runtime.clone();
    #[cfg(not(target_arch = "wasm32"))]
    let save_runtime = runtime.clone();
    let onaction = EventHandler::new(move |event| {
        #[cfg(target_arch = "wasm32")]
        if let Some(connection) = &connection {
            connection.dispatch(event);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Err(message) = runtime.borrow_mut().dispatch(event) {
                error.set(Some(message));
            }
            let mut revision = revision;
            let next = revision.peek().wrapping_add(1);
            revision.set(next);
        }
    });
    let onsave = EventHandler::new(move |document| {
        #[cfg(target_arch = "wasm32")]
        if let Some(connection) = &save_connection {
            connection.save_configuration(document);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Err(message) = save_runtime.borrow_mut().save_configuration(document) {
                error.set(Some(message));
            }
            let mut revision = revision;
            let next = revision.peek().wrapping_add(1);
            revision.set(next);
        }
    });
    let onsessionform = EventHandler::new(move |edit| {
        #[cfg(target_arch = "wasm32")]
        if let Some(connection) = &form_connection {
            connection.edit_session_form(edit);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Err(message) = form_runtime.borrow_mut().edit_session_form(edit) {
                error.set(Some(message));
            }
            let mut revision = revision;
            let next = revision.peek().wrapping_add(1);
            revision.set(next);
        }
    });
    let onexecute = EventHandler::new(move |_mutation| {
        error.set(Some("No runtime is connected for resource actions.".into()));
    });
    let open = EventHandler::new(move |url: String| {
        #[cfg(target_arch = "wasm32")]
        if let Some(connection) = &link_connection {
            connection.open_url(&url);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            drop(url);
            error.set(Some(
                "External links require an installed host adapter.".into(),
            ));
        }
    });
    let onopen = capabilities
        .supports(web_ui::host::HostCapability::OpenExternal)
        .then_some(open);
    let destination = crate::destinations::destination(&view, onaction, onsave, onexecute);
    rsx! { WorkspaceSurface {
        destination, now_ms, view, capabilities, session_forms: Some(session_forms), onsessionform, surface: surface(), error: error(), onaction, onopen,
    } }
}

pub(crate) fn surface() -> Surface {
    #[cfg(target_arch = "wasm32")]
    if web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("main"))
        .and_then(|element| element.get_attribute("data-view-kind"))
        .as_deref()
        == Some("detail")
    {
        return Surface::Detail;
    }
    #[cfg(target_arch = "wasm32")]
    if let Some(section) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("main"))
        .and_then(|element| element.get_attribute("data-view-section"))
        .and_then(|section| serde_json::from_value(serde_json::Value::String(section)).ok())
    {
        return Surface::SidebarPane(section);
    }
    Surface::Sidebar
}
