use app_core::{ViewModel, subscriptions};
use idle_protocol::v1::standalone::{RepositoryRecovery, RepositorySnapshot};
use serde_json::{Value, json};

use super::Adapter;

impl Adapter {
    pub(super) fn subscription(
        &mut self,
        operation: &subscriptions::SubscriptionOperation,
        data: Value,
        id: &str,
        view: &ViewModel,
    ) -> Result<Option<Value>, String> {
        if view.subscriptions.context.as_ref() != Some(&operation.context) {
            return Err("Subscription context changed".into());
        }
        match &operation.action {
            subscriptions::SubscriptionAction::Join => {
                if self.latest_join.as_deref() != Some(id) {
                    return Err("Subscription join was retired".into());
                }
                let snapshot: RepositorySnapshot =
                    serde_json::from_value(data).map_err(|error| error.to_string())?;
                if snapshot.as_of.workspace_id.0 != operation.context.workspace
                    || snapshot.as_of.contributor_id.0 != operation.context.contributor
                    || snapshot.workspace.value.chain.0 != operation.context.chain
                {
                    return Err("Coordinator subscription scope differs".into());
                }
                self.connections.clear();
                let _previous = self.connections.insert(id.into(), snapshot.as_of);
                Ok(Some(
                    json!({"Ok": subscriptions::SubscriptionResult::Joined { connection: id.into() }}),
                ))
            }
            subscriptions::SubscriptionAction::Watch { connection } => {
                let cursor = self
                    .connections
                    .get_mut(connection)
                    .ok_or("Subscription was retired")?;
                let result: RepositoryRecovery =
                    serde_json::from_value(data).map_err(|error| error.to_string())?;
                match result {
                    RepositoryRecovery::Events {
                        events, through, ..
                    } => {
                        if cursor
                            .compare_position(&through)
                            .is_none_or(std::cmp::Ordering::is_gt)
                        {
                            return Err(
                                "Coordinator recovery cursor regressed or changed scope".into()
                            );
                        }
                        let mut previous = cursor.clone();
                        for event in &events {
                            if previous.compare_position(&event.cursor)
                                != Some(std::cmp::Ordering::Less)
                                || event
                                    .cursor
                                    .compare_position(&through)
                                    .is_none_or(std::cmp::Ordering::is_gt)
                            {
                                return Err("Coordinator events are out of order or scope".into());
                            }
                            previous = event.cursor.clone();
                        }
                        *cursor = through;
                        Ok((!events.is_empty())
                            .then(|| json!({"Ok": subscriptions::SubscriptionResult::Changed})))
                    }
                    RepositoryRecovery::SnapshotRequired => {
                        let _retired = self.connections.remove(connection);
                        Ok(Some(
                            json!({"Ok": subscriptions::SubscriptionResult::Closed}),
                        ))
                    }
                }
            }
            subscriptions::SubscriptionAction::Wait { .. }
            | subscriptions::SubscriptionAction::Leave { .. } => {
                Err("Unexpected coordinator subscription result".into())
            }
        }
    }
}
