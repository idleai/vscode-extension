//! Startup handshake only; application request correlation stays in app-core.

use js_sys::{Function, Promise};
use serde_json::json;
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;

use super::browser::{javascript_error, json_to_js, window};
use super::{BridgeError, HostMessage, READY_METHOD, VsCodeBridge};

const READY_ID: &str = "host:ready";
const READY_TIMEOUT_MS: i32 = 10_000;

/// Initialize the platform connection and return the host's ready result.
///
/// Exported as `initializeHostBridge()` for the webview bootstrap. The listener
/// is installed before sending `host.ready` and removed after completion. The
/// result contains platform capabilities/configuration; domain event adapters
/// install their own subscriptions using [`VsCodeBridge::subscribe`]. Repeated
/// calls reuse the single API acquisition and perform a fresh ready handshake.
///
/// # Errors
/// Rejects on missing host/session, malformed response, host error, failed send
/// or a ten-second timeout. JavaScript callers receive an `Error` object.
#[wasm_bindgen(js_name = initializeHostBridge)]
pub async fn initialize_host_bridge() -> Result<JsValue, JsValue> {
    initialize().await.map_err(|error| error_value(&error))
}

async fn initialize() -> Result<JsValue, BridgeError> {
    let bridge = VsCodeBridge::acquire_from_document()?;
    let completion = Completion::new()?;
    let resolve = completion.resolve.clone();
    let reject = completion.reject.clone();
    let mut subscription = bridge.subscribe(move |message| match message {
        Ok(HostMessage::Response { id, result }) if id == READY_ID => {
            match result.and_then(|value| json_to_js(&value)) {
                Ok(value) => settle(&resolve, &value),
                Err(error) => settle(&reject, &error_value(&error)),
            }
        }
        Ok(HostMessage::Response { .. } | HostMessage::Event { .. }) => {}
        Err(error) => settle(&reject, &error_value(&error)),
    })?;
    let timeout = HandshakeTimeout::new(completion.reject)?;
    bridge
        .post_request(READY_ID, READY_METHOD, json!({}))
        .await?;
    let result = JsFuture::from(completion.promise).await;
    subscription.dispose()?;
    drop(timeout);
    result.map_err(|error| javascript_error("host.ready", &error))
}

struct Completion {
    promise: Promise,
    resolve: Function,
    reject: Function,
}

impl Completion {
    fn new() -> Result<Self, BridgeError> {
        let mut callbacks = None;
        let promise = Promise::new(&mut |resolve, reject| callbacks = Some((resolve, reject)));
        let (resolve, reject) = callbacks.ok_or_else(|| {
            BridgeError::new(
                "handshake_failed",
                "Browser did not initialize the ready promise",
            )
        })?;
        Ok(Self {
            promise,
            resolve,
            reject,
        })
    }
}

struct HandshakeTimeout {
    window: web_sys::Window,
    handle: i32,
    _callback: Closure<dyn FnMut()>,
}

impl HandshakeTimeout {
    fn new(reject: Function) -> Result<Self, BridgeError> {
        let window = window()?;
        let callback = Closure::<dyn FnMut()>::wrap(Box::new(move || {
            let error =
                BridgeError::new("handshake_timeout", "Extension host did not become ready");
            settle(&reject, &error_value(&error));
        }));
        let handle = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.as_ref().unchecked_ref(),
                READY_TIMEOUT_MS,
            )
            .map_err(|error| javascript_error("ready timeout", &error))?;
        Ok(Self {
            window,
            handle,
            _callback: callback,
        })
    }
}

impl Drop for HandshakeTimeout {
    fn drop(&mut self) {
        self.window.clear_timeout_with_handle(self.handle);
    }
}

fn error_value(error: &BridgeError) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn settle(callback: &Function, value: &JsValue) {
    if let Err(error) = callback.call1(&JsValue::UNDEFINED, value) {
        web_sys::console::error_1(&error);
    }
}
