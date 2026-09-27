//! Browser bindings; the acquired VS Code API stays private to Rust.

use std::cell::OnceCell;

use serde_json::Value;
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;

use super::{BridgeError, HostMessage, HostProtocol};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = acquireVsCodeApi, catch)]
    fn acquire_vscode_api() -> Result<JsValue, JsValue>;
}

thread_local! {
    // VS Code permits exactly one acquisition per document, including when
    // multiple Rust adapters acquire their own bridge handle.
    static VSCODE_API: OnceCell<Result<JsValue, BridgeError>> = const { OnceCell::new() };
}

/// A cloneable handle to the document's single acquired VS Code API.
#[derive(Debug, Clone)]
pub struct VsCodeBridge {
    api: JsValue,
    protocol: HostProtocol,
}

impl VsCodeBridge {
    /// Acquire or reuse the document's private API, bound to its host session.
    ///
    /// Failed acquisition is also cached: VS Code's single-acquisition contract
    /// must not be retried after a partially completed host initialization.
    ///
    /// # Errors
    /// Returns an error for an empty session or failed VS Code API acquisition.
    pub fn acquire(session: impl Into<String>) -> Result<Self, BridgeError> {
        let protocol = HostProtocol::new(session)?;
        let api = VSCODE_API.with(|cell| {
            cell.get_or_init(|| {
                acquire_vscode_api().map_err(|error| javascript_error("acquireVsCodeApi", &error))
            })
            .clone()
        })?;
        Ok(Self { api, protocol })
    }

    /// Read the session injected by the host into `#main[data-host-session]`.
    ///
    /// # Errors
    /// Returns an error when the document/session is missing or API acquisition
    /// fails. The session is not restored from persisted domain state.
    pub fn acquire_from_document() -> Result<Self, BridgeError> {
        let session = window()?
            .document()
            .and_then(|document| document.get_element_by_id("main"))
            .and_then(|element| element.get_attribute("data-host-session"))
            .ok_or_else(|| {
                BridgeError::new("missing_session", "Webview document has no host session")
            })?;
        Self::acquire(session)
    }

    /// Return this handle's immutable envelope/session validator.
    #[must_use]
    pub const fn protocol(&self) -> &HostProtocol {
        &self.protocol
    }

    /// Restore the caller-owned persisted JSON state.
    ///
    /// `undefined` means no previous state; explicit JSON null remains a value.
    /// This adapter does not interpret, migrate or reconcile domain state.
    ///
    /// # Errors
    /// Returns JavaScript method failures and invalid/non-JSON state to the caller.
    pub fn get_state(&self) -> Result<Option<Value>, BridgeError> {
        let value = call(&self.api, "getState", &[])?;
        if value.is_undefined() {
            return Ok(None);
        }
        json_from_js(&value).map(Some)
    }

    /// Persist caller-owned JSON state using VS Code's webview state storage.
    ///
    /// # Errors
    /// Returns conversion and JavaScript method failures to the caller.
    pub fn set_state(&self, state: &Value) -> Result<(), BridgeError> {
        let value = json_to_js(state)?;
        call(&self.api, "setState", std::slice::from_ref(&value)).map(|_| ())
    }

    /// Send a platform request after yielding to the browser's microtask queue.
    ///
    /// Deferral preserves the history renderer's reentrancy contract: even a
    /// fixture that dispatches a response synchronously from `postMessage`
    /// cannot reenter the message callback that requested this send. Subscribe
    /// before polling this future so an immediate response is not lost.
    ///
    /// # Errors
    /// Returns invalid request, JSON conversion and JavaScript method failures.
    /// A successful send only confirms dispatch, not the operation's outcome.
    pub async fn post_request(
        &self,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<(), BridgeError> {
        let value = json_to_js(&self.protocol.request(id, method, params)?)?;
        drop(
            JsFuture::from(js_sys::Promise::resolve(&JsValue::UNDEFINED))
                .await
                .map_err(|error| javascript_error("deferred post", &error))?,
        );
        call(&self.api, "postMessage", std::slice::from_ref(&value)).map(|_| ())
    }

    /// Subscribe to validated host envelopes and explicit decoding failures.
    ///
    /// Keep the returned subscription alive while receiving messages. Dropping
    /// it unregisters the callback; no closure is leaked into the document.
    ///
    /// # Errors
    /// Returns an error if the browser window or listener registration fails.
    pub fn subscribe(
        &self,
        mut receive: impl FnMut(Result<HostMessage, BridgeError>) + 'static,
    ) -> Result<MessageSubscription, BridgeError> {
        let window = window()?;
        let protocol = self.protocol.clone();
        let callback = Closure::<dyn FnMut(web_sys::MessageEvent)>::wrap(Box::new(
            move |event: web_sys::MessageEvent| {
                receive(json_from_js(&event.data()).and_then(|value| protocol.decode(&value)));
            },
        ));
        window
            .add_event_listener_with_callback("message", callback.as_ref().unchecked_ref())
            .map_err(|error| javascript_error("subscribe", &error))?;
        Ok(MessageSubscription {
            window,
            callback: Some(callback),
        })
    }
}

/// A message listener that unregisters its callback when disposed or dropped.
#[derive(Debug)]
#[must_use = "Dropping the subscription unregisters the host message listener"]
pub struct MessageSubscription {
    window: web_sys::Window,
    callback: Option<Closure<dyn FnMut(web_sys::MessageEvent)>>,
}

impl MessageSubscription {
    /// Stop receiving messages. Repeated disposal is harmless.
    ///
    /// # Errors
    /// Returns listener removal failures. The subscription remains owned so the
    /// caller can retry; drop reports unexpected removal errors to the console.
    pub fn dispose(&mut self) -> Result<(), BridgeError> {
        if let Some(callback) = &self.callback {
            self.window
                .remove_event_listener_with_callback("message", callback.as_ref().unchecked_ref())
                .map_err(|error| javascript_error("unsubscribe", &error))?;
            drop(self.callback.take());
        }
        Ok(())
    }
}

impl Drop for MessageSubscription {
    fn drop(&mut self) {
        if let Err(error) = self.dispose() {
            web_sys::console::error_1(&JsValue::from_str(&error.to_string()));
        }
    }
}

pub(super) fn window() -> Result<web_sys::Window, BridgeError> {
    web_sys::window()
        .ok_or_else(|| BridgeError::new("browser_unavailable", "Browser window is unavailable"))
}

fn call(api: &JsValue, method: &str, args: &[JsValue]) -> Result<JsValue, BridgeError> {
    let function = js_sys::Reflect::get(api, &JsValue::from_str(method))
        .and_then(JsCast::dyn_into::<js_sys::Function>)
        .map_err(|error| javascript_error(method, &error))?;
    let arguments = args.iter().collect::<js_sys::Array>();
    js_sys::Reflect::apply(&function, api, &arguments)
        .map_err(|error| javascript_error(method, &error))
}

pub(super) fn javascript_error(operation: &str, error: &JsValue) -> BridgeError {
    let detail = error.as_string().unwrap_or_else(|| format!("{error:?}"));
    BridgeError::new("javascript_error", format!("{operation} failed: {detail}"))
}

pub(super) fn json_to_js(value: &Value) -> Result<JsValue, BridgeError> {
    js_sys::JSON::parse(&value.to_string()).map_err(|error| javascript_error("JSON.parse", &error))
}

fn json_from_js(value: &JsValue) -> Result<Value, BridgeError> {
    let text = js_sys::JSON::stringify(value)
        .map_err(|error| javascript_error("JSON.stringify", &error))?
        .as_string()
        .ok_or_else(|| BridgeError::new("invalid_json", "Host value is not JSON"))?;
    serde_json::from_str(&text).map_err(|error| BridgeError::new("invalid_json", error.to_string()))
}
