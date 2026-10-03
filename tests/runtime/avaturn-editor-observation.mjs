// TEST-ONLY passive facts from one mounted, real AvatarEditor class instance.
// This is not a browser/network terminal oracle or runtime acceptance.
export const AVATURN_OBSERVATION_CEILING_MS = 300_000;
export const AVATURN_OBSERVATION_INTERVAL_MS = 100;

export function createAvaturnEditorObservation() {
  let originalEditor = null;
  let attachedEditor = null;
  let originalController = null;
  let originalSignal = null;
  let selectionId = null;
  let abortListener = null;
  let stopped = false;
  let editorMountCount = 0;
  const controllers = new Set();
  const invalidReasons = new Set();
  const facts = {
    upload_started: false,
    abort_event_seen: false,
    aborted_signal: false,
    upload_drained: false,
    same_editor_instance: false,
    upload_in_flight: false,
    original_controller_present: false,
    creator_enabled: null,
    socket_connected: null,
    off_observed: false,
    is_current_guards: null,
    saved_state_seen: false,
    callbackcount: 0,
  };

  const invalidate = reason => {
    invalidReasons.add(reason);
    facts.upload_drained = false;
  };
  const removeAbortListener = () => {
    if (originalSignal && abortListener) originalSignal.removeEventListener("abort", abortListener);
    abortListener = null;
  };
  const snapshot = () => Object.freeze({
    observation_state: stopped ? "STOPPED" : invalidReasons.size ? "INVALID" :
      facts.upload_drained ? "UPLOAD_DRAINED" : facts.abort_event_seen ? "ABORTED_SIGNAL" :
      facts.upload_started ? "UPLOAD_IN_FLIGHT" : originalEditor ? "WAITING_UPLOAD" : "WAITING_EDITOR",
    ...facts,
    controller_seen_count: controllers.size,
    editor_mount_count: editorMountCount,
    invalid_reasons: Object.freeze([...invalidReasons]),
  });

  function attachEditor(editor) {
    if (stopped) return snapshot();
    if (editor === null) {
      attachedEditor = null;
      facts.same_editor_instance = false;
      facts.is_current_guards = null;
      if (originalEditor) invalidate("editor_unmounted");
      removeAbortListener();
      return snapshot();
    }
    if (attachedEditor !== editor) {
      editorMountCount += 1;
      if (originalEditor) invalidate(editor === originalEditor ? "editor_remounted" : "editor_replaced");
    }
    if (!originalEditor) originalEditor = editor;
    attachedEditor = editor;
    return snapshot();
  }

  function sample({ creatorEnabled, socketConnected, callbackcount }) {
    // The harness passes its existing all-callback counter, never a filtered
    // negative-case counter. Keep it visible even after invalidation/cleanup.
    if (!Number.isSafeInteger(callbackcount) || callbackcount < 0) invalidate("callbackcount_unavailable");
    else {
      if (callbackcount < facts.callbackcount) invalidate("callbackcount_regressed");
      facts.callbackcount = callbackcount;
    }
    if (stopped) return snapshot();
    if (typeof creatorEnabled !== "boolean" || typeof socketConnected !== "boolean") {
      invalidate("live_context_unavailable");
      return snapshot();
    }
    facts.creator_enabled = creatorEnabled;
    facts.socket_connected = socketConnected;
    if (facts.upload_started && !creatorEnabled) facts.off_observed = true;
    if (!originalEditor || !attachedEditor) return snapshot();
    facts.same_editor_instance = attachedEditor === originalEditor && originalEditor.unmounted === false &&
      editorMountCount === 1;
    if (!facts.same_editor_instance) {
      facts.is_current_guards = null;
      invalidate(originalEditor.unmounted === true ? "editor_unmounted" : "editor_identity_unavailable");
      removeAbortListener();
      return snapshot();
    }

    const controller = originalEditor.avaturnSaveController;
    facts.upload_in_flight = originalEditor.uploadInFlight === true;
    if (controller !== null && controller !== undefined) {
      controllers.add(controller);
      if (controllers.size !== 1) invalidate("multiple_controllers");
      if (!originalController) {
        originalController = controller;
        if (!(controller instanceof AbortController) || !(controller.signal instanceof AbortSignal)) {
          invalidate("controller_signal_unavailable");
        } else {
          originalSignal = controller.signal;
          selectionId = originalEditor.glbSelectionId;
          if (originalEditor.props?.mode !== "avaturn" || !Number.isSafeInteger(selectionId) || selectionId < 0)
            invalidate("editor_upload_contract_unavailable");
          if (!facts.upload_in_flight) invalidate("controller_without_inflight_upload");
          if (!creatorEnabled || !socketConnected) invalidate("controller_first_seen_after_revocation");
          if (originalSignal.aborted) invalidate("signal_already_aborted_when_first_seen");
          facts.upload_started = invalidReasons.size === 0;
          abortListener = event => {
            if (stopped) return;
            // Dispatching an arbitrary event is not evidence of an abort. This
            // listener is attached only to the first actual controller signal.
            if (event.target !== originalSignal || !originalSignal.aborted) {
              invalidate("abort_event_without_aborted_original_signal");
              return;
            }
            facts.abort_event_seen = true;
            facts.aborted_signal = true;
          };
          originalSignal.addEventListener("abort", abortListener);
        }
      } else if (facts.upload_drained && controller === originalController) {
        invalidate("original_controller_reappeared");
      }
    }
    facts.original_controller_present = !!originalController && controller === originalController;
    if (originalSignal) facts.aborted_signal = originalSignal.aborted === true;
    if (facts.upload_started) facts.is_current_guards = originalEditor.glbSelectionId === selectionId && creatorEnabled;
    if (facts.upload_started &&
        (originalEditor.savedAvaturn != null || originalEditor.state?.avaturnSaveState === "saved"))
      facts.saved_state_seen = true;
    if (facts.off_observed && facts.saved_state_seen) invalidate("save_state_seen_during_cancel_observation");

    // OFF's invalidateCreatorFile/setState do NOT clear either of these fields.
    // Only the unchanged product finally clears the original controller and
    // uploadInFlight. Never count initial/receiving/invalidating UI as drained.
    facts.upload_drained = invalidReasons.size === 0 && facts.upload_started &&
      controllers.size === 1 && facts.abort_event_seen && facts.aborted_signal && facts.off_observed &&
      facts.same_editor_instance && controller === null && originalEditor.uploadInFlight === false;
    return snapshot();
  }

  function stop(reason = "harness_teardown") {
    if (!stopped) {
      stopped = true;
      invalidate(reason === "deadline" ? "observation_deadline" : "harness_teardown");
      removeAbortListener();
      facts.same_editor_instance = false;
      facts.is_current_guards = null;
    }
    return snapshot();
  }

  return Object.freeze({ attachEditor, sample, snapshot, stop });
}
