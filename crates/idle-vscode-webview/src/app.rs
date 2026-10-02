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
    let (view, capabilities) = connection.as_ref().map_or_else(
        || {
            (
                app_core::ViewModel::default(),
                web_ui::host::HostCapabilities::new(web_ui::host::HostKind::VsCode),
            )
        },
        |connection| {
            let runtime = connection.runtime.borrow();
            (runtime.view(), runtime.capabilities())
        },
    );
    #[cfg(not(target_arch = "wasm32"))]
    let runtime =
        use_hook(|| std::rc::Rc::new(std::cell::RefCell::new(crate::adapters::Runtime::default())));
    #[cfg(not(target_arch = "wasm32"))]
    let (view, capabilities) = (runtime.borrow().view(), runtime.borrow().capabilities());
    rsx! { WorkspaceSurface {
        view, capabilities, surface: surface(), error: error(),
        onaction: move |event| {
            #[cfg(target_arch = "wasm32")]
            if let Some(connection) = &connection { connection.dispatch(event); }
            #[cfg(not(target_arch = "wasm32"))]
            {
                if let Err(message) = runtime.borrow_mut().dispatch(event) { error.set(Some(message)); }
                let mut revision = revision;
                let next = revision.peek().wrapping_add(1);
                revision.set(next);
            }
        },
    } }
}

fn surface() -> Surface {
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
    Surface::Sidebar
}
