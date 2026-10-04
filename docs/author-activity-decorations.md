# Native author and exposure decorations

Idle adds a summary beside the first line and range indicators in native text
editors. Hover an indicator to open its exact record or Original, or run
**Idle: Show Author and Exposure Sources** to inspect all supporting records,
the recorded file, or its diff. `idle.decorations.enabled` controls the display
per resource. Workspace Trust is required.

Working buffers use the active capture session, document incarnation and buffer
version. Recorded file previews and the resulting side of recorded diffs use
their full record ID and digest, source namespace and history connection
generation. The native query resolves the snapshot through engine content APIs;
the host compares every byte of its UTF-8 text with the displayed buffer before
painting ranges. Equal content in another revision, window or checkout does not
transfer authorship or exposure. Unsaved buffers are supported. Buffers without
an active capture occurrence display unavailable observations.

The Rust projection in `idle-history-native::activity` distinguishes recorded
person/agent/tool authors from recorder identities. Editor input receipts can
arrive later and refer to the exact earlier change. Recorded UTF-16 replacements
are replayed against their full base snapshot and checked against the resulting
snapshot before their inserted ranges are marked. Unchanged text between edits
is excluded. Without valid edit ranges, attribution is a file observation only;
it does not assign every line to that author. Earlier revisions' author ranges
are not carried across subsequent changes.

Visibility and read observations require the same recorded revision, path and
resulting content. Disjoint ranges remain separate. Byte and UTF-16 ranges are
validated against the snapshot, including surrogate pairs and line endings.
These observations do not establish review or comprehension. Missing exposure
is unknown, and is never labeled unread. No range from the resulting revision is
applied to the before side of a diff.

Missing or corrupt snapshots, quarantined records, missing parent observations,
conflicting author registrations, capture gaps, unsupported receipts and invalid
ranges remain explicit. Reads inspect at most 4,000 candidates per indexed
query, return at most 512 indicators, and accept snapshots up to the capture
limit of 8 MiB. Reaching a bound reports incomplete observations. A session gap
is disclosed with unknown affected ranges. Native history actions retain their
existing handling of aliases and separately installed retained sources.

Decorations run with all Idle webviews closed. Capture delivery, collector and
sharing notifications, history binding changes, buffer edits, visible editor
changes, settings, trust and native restarts invalidate pending reads and clear
old marks. Requests are coalesced, cancelled and checked again before rendering.
Every refresh reads the current index, including lower-ID arrivals, late blobs
and conflict retractions. Source actions retain the same repository/chain/source
binding and full record references used by the query.

The native tests exercise real capture conversion, late receipts, exact native
source actions, Unicode edits, repeated content, missing/empty/late snapshots,
author/recorder separation, conflicts, limits and the framed service. Host tests
cover split editors, unsaved revisions, stale results, multi-root source actions,
historical documents, settings, trust and disposal. The package smoke check also
reads the projection through the packaged history service.
