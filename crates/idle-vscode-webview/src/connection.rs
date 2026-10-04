//! Document-owned event pump. Platform services outlive this listener.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

use app_core::Event;
use dioxus::prelude::{ReadableExt, Signal, WritableExt};
use serde_json::json;
use wasm_bindgen::{JsCast, closure::Closure};

use crate::adapters::{Call, Runtime};
use crate::bridge::{BridgeError, HostMessage, MessageSubscription, VsCodeBridge};

pub(crate) struct Connection {
    pub(crate) runtime: RefCell<Runtime>,
    revision: Signal<u64>,
    error: Signal<Option<String>>,
    bridge: VsCodeBridge,
    listener: RefCell<Option<MessageSubscription>>,
    generation: Cell<u64>,
    ready_pending: Cell<bool>,
    next_external: Cell<u64>,
    timers: RefCell<BTreeMap<String, Timeout>>,
}

impl Connection {
    pub(crate) fn new(
        revision: Signal<u64>,
        error: Signal<Option<String>>,
    ) -> Result<Rc<Self>, String> {
        let bridge = VsCodeBridge::acquire_from_document().map_err(|error| error.to_string())?;
        let connection = Rc::new(Self {
            runtime: RefCell::new(Runtime::default()),
            revision,
            error,
            bridge,
            listener: RefCell::new(None),
            generation: Cell::new(0),
            ready_pending: Cell::new(false),
            next_external: Cell::new(0),
            timers: RefCell::new(BTreeMap::new()),
        });
        let weak = Rc::downgrade(&connection);
        let listener = connection
            .bridge
            .subscribe(move |message| {
                if let Some(connection) = weak.upgrade() {
                    match message {
                        Ok(message) => connection.receive(message),
                        Err(error) => connection.report(error.to_string()),
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        *connection.listener.borrow_mut() = Some(listener);
        connection.handshake();
        Ok(connection)
    }

    pub(crate) fn dispatch(self: &Rc<Self>, event: Event) {
        let calls = self.runtime.borrow_mut().dispatch(event);
        self.publish(calls);
    }

    pub(crate) fn save_configuration(
        self: &Rc<Self>,
        document: app_core::configuration::ConfigurationDocument,
    ) {
        let calls = self.runtime.borrow_mut().save_configuration(document);
        self.publish(calls);
    }

    pub(crate) fn open_url(self: &Rc<Self>, url: &str) {
        if !self
            .runtime
            .borrow()
            .capabilities()
            .supports(web_ui::host::HostCapability::OpenExternal)
        {
            self.report("External links are unavailable on this connection.".into());
            return;
        }
        let Some(next) = self.next_external.get().checked_add(1) else {
            self.report("External-link request identities exhausted.".into());
            return;
        };
        self.next_external.set(next);
        self.send(Call {
            id: format!("external:{}:{next}", self.generation.get()),
            method: "external.open",
            params: json!({"url":url}),
        });
    }

    fn handshake(self: &Rc<Self>) {
        // Clear private state and actions immediately, before waiting for the host.
        self.runtime.borrow_mut().invalidate();
        self.timers.borrow_mut().clear();
        let mut error = self.error;
        error.set(None);
        self.generation.set(self.generation.get().wrapping_add(1));
        self.ready_pending.set(true);
        self.bump();
        self.send(Call {
            id: format!("ready:{}", self.generation.get()),
            method: "host.ready",
            params: json!({}),
        });
    }

    fn receive(self: &Rc<Self>, message: HostMessage) {
        if let HostMessage::Response { id, .. } = &message {
            let _timer = self.timers.borrow_mut().remove(id);
        }
        if let HostMessage::Response { id, result } = &message
            && id.starts_with(&format!("external:{}:", self.generation.get()))
        {
            if let Err(error) = result {
                self.report(error.to_string());
            }
            return;
        }
        let calls = match message {
            HostMessage::Event { event, .. } if event == "host.configurationChanged" => {
                self.handshake();
                return;
            }
            HostMessage::Event { event, params } if event == "history.changed" => {
                self.runtime.borrow_mut().history_changed(&params)
            }
            HostMessage::Event { .. } => return,
            HostMessage::Response { id, result }
                if id == format!("ready:{}", self.generation.get())
                    && self.ready_pending.replace(false) =>
            {
                match result {
                    Ok(value) => self.runtime.borrow_mut().ready(&value),
                    Err(error) => Err(error.to_string()),
                }
            }
            HostMessage::Response { id, result } => self.runtime.borrow_mut().receive(&id, result),
        };
        self.publish(calls);
    }

    fn publish(self: &Rc<Self>, result: Result<Vec<Call>, String>) {
        self.bump();
        match result {
            Ok(calls) => {
                if let Some(message) = self.runtime.borrow().draft_error() {
                    self.report(message.into());
                }
                for call in calls {
                    self.send(call);
                }
            }
            Err(error) => self.report(error),
        }
    }

    fn send(self: &Rc<Self>, call: Call) {
        let weak = Rc::downgrade(self);
        let bridge = self.bridge.clone();
        match Timeout::new(self, &call) {
            Ok(timer) => {
                let _old = self.timers.borrow_mut().insert(call.id.clone(), timer);
            }
            Err(message) => {
                self.receive(HostMessage::Response {
                    id: call.id,
                    result: Err(BridgeError {
                        code: "timer_unavailable".to_owned(),
                        message,
                        details: None,
                    }),
                });
                return;
            }
        }
        wasm_bindgen_futures::spawn_local(async move {
            if let Err(error) = bridge
                .post_request(&call.id, call.method, call.params)
                .await
                && let Some(connection) = weak.upgrade()
            {
                connection.receive(HostMessage::Response {
                    id: call.id,
                    result: Err(error),
                });
            }
        });
    }

    fn bump(&self) {
        let mut revision = self.revision;
        let next = revision.peek().wrapping_add(1);
        revision.set(next);
    }

    fn report(&self, message: String) {
        let mut error = self.error;
        error.set(Some(message));
    }
}

struct Timeout {
    window: web_sys::Window,
    handle: i32,
    _callback: Closure<dyn FnMut()>,
}

impl Timeout {
    fn new(connection: &Rc<Connection>, call: &Call) -> Result<Self, String> {
        let window = web_sys::window().ok_or("Browser window is unavailable")?;
        let weak = Rc::downgrade(connection);
        let signing_in = call.method == "app.repository"
            && call
                .params
                .pointer("/operation/action")
                .and_then(serde_json::Value::as_str)
                == Some("SignIn");
        let id = call.id.clone();
        let callback = Closure::<dyn FnMut()>::wrap(Box::new(move || {
            if let Some(connection) = weak.upgrade() {
                connection.receive(HostMessage::Response {
                    id: id.clone(),
                    result: Err(BridgeError {
                        code: "host_timeout".to_owned(),
                        message: if signing_in {
                            "GitHub sign-in has not finished. Finish or cancel sign-in in VS Code, then retry."
                        } else {
                            "The host did not respond. Retry the operation."
                        }.to_owned(),
                        details: None,
                    }),
                });
            }
        }));
        let handle = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.as_ref().unchecked_ref(),
                if signing_in { 600_000 } else { 60_000 },
            )
            .map_err(|_error| "Unable to start the host timeout".to_owned())?;
        Ok(Self {
            window,
            handle,
            _callback: callback,
        })
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        self.window.clear_timeout_with_handle(self.handle);
    }
}
