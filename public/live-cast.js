import { api } from './core.js';

let sdk;
export function prepareLiveCast() {
  if (sdk) return sdk;
  if (!window.isSecureContext || !/Chrome\//.test(navigator.userAgent))
    return Promise.reject(Error('Cast from Chrome over HTTPS, on the same Wi-Fi as your TV.'));
  sdk = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('Casting could not load. Reload and try again.')),
      15000,
    );
    window.__onGCastApiAvailable = (available) => {
      clearTimeout(timer);
      if (!available) return reject(Error('Casting is unavailable in this browser. Use Chrome.'));
      const context = window.cast.framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      resolve(context);
    };
    const script = document.createElement('script');
    script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.onerror = () => {
      clearTimeout(timer);
      reject(Error('Casting could not load. Reload and try again.'));
    };
    document.head.appendChild(script);
  });
  return sdk;
}

export function bindLiveCast({
  session,
  button,
  stopButton,
  pauseButton,
  status,
  onStart,
  onStop,
  prepare = prepareLiveCast,
  request = api,
  origin = location.origin,
}) {
  let context,
    receiver,
    grant,
    controller,
    remote,
    selection,
    disposed = false,
    busy = false;
  const framework = () => window.cast.framework;
  const ownsReceiver = () =>
    receiver?.getMediaSession()?.media?.contentId ===
    (grant ? new URL(grant.url, origin).href : null);
  const message = (text) => {
    if (!disposed) status.textContent = text;
  };
  const revoke = async (value) => {
    if (value)
      await request(`/api/live/sessions/${session.id}`, { lease: value.lease }, 'DELETE').catch(
        () => {},
      );
  };
  const render = () => {
    if (disposed || !grant) return;
    const current = receiver?.getMediaSession();
    // CAF can briefly clear media information while synchronizing a load.
    // Revoke access only when another item actually replaces our stream.
    if (current?.media?.contentId && !ownsReceiver()) {
      void stop(false);
      return;
    }
    if (current?.playerState === 'IDLE' && current.idleReason) {
      void stop(
        false,
        current.idleReason === 'ERROR'
          ? 'The TV could not play this stream. Try casting again or choose another channel.'
          : 'TV playback ended.',
      );
      return;
    }
    pauseButton.textContent = remote.isPaused ? 'Play on TV' : 'Pause TV';
    const state = current?.playerState;
    const action = remote.isPaused ? 'Paused' : state === 'PLAYING' ? 'Playing' : 'Buffering';
    message(`${action} on ${receiver.getCastDevice().friendlyName}`);
  };
  const disconnected = (event) => {
    const states = framework().SessionState;
    if ([states.SESSION_STARTED, states.SESSION_RESUMED].includes(event.sessionState))
      selection?.ready();
    if ([states.SESSION_START_FAILED, states.SESSION_ENDED].includes(event.sessionState))
      selection?.fail({ code: 'session_error' });
    if (event.sessionState === framework().SessionState.SESSION_ENDED && grant) void stop(false);
  };
  function selectReceiver() {
    const ready = () => {
      const states = framework().SessionState;
      return [states.SESSION_STARTED, states.SESSION_RESUMED].includes(context.getSessionState())
        ? context.getCurrentSession()
        : null;
    };
    if (ready()) return Promise.resolve(ready());
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (selection === attempt) selection = null;
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(null, { code: 'timeout' }), 120000);
      const attempt = {
        ready: () => {
          const value = ready();
          if (value) finish(value);
        },
        fail: (error) => finish(null, error),
      };
      selection = attempt;
      // Keep this call in the click gesture. Its promise can resolve before
      // SESSION_STARTED; load only after CAF confirms the receiver is ready.
      try {
        context.requestSession().then(
          () => attempt.ready(),
          (error) => attempt.fail(error),
        );
      } catch (error) {
        attempt.fail(error);
      }
    });
  }
  async function stop(endReceiver = true, reason = '') {
    const previous = grant;
    grant = null;
    if (controller)
      controller.removeEventListener(framework().RemotePlayerEventType.ANY_CHANGE, render);
    controller = remote = null;
    if (
      endReceiver &&
      previous &&
      receiver?.getMediaSession()?.media?.contentId === new URL(previous.url, origin).href
    )
      receiver.endSession(true);
    receiver = null;
    stopButton.hidden = pauseButton.hidden = true;
    button.hidden = false;
    await revoke(previous);
    if (!disposed && previous) {
      onStop();
      message(reason);
    }
  }
  prepare()
    .then((value) => {
      if (disposed) return;
      context = value;
      context.addEventListener(
        framework().CastContextEventType.SESSION_STATE_CHANGED,
        disconnected,
      );
      button.disabled = false;
      button.title = 'Cast to a TV on the same Wi-Fi';
    })
    .catch((error) => {
      if (!disposed) {
        button.disabled = false;
        button.title = error.message;
      }
    });
  button.disabled = true;
  button.onclick = async () => {
    if (busy || disposed) return;
    if (!context) {
      message(button.title || 'Casting is loading. Try again.');
      return;
    }
    busy = true;
    button.disabled = true;
    message('Select your TV in Chrome’s Cast panel.');
    let pending;
    let stage = 'connect';
    try {
      receiver = await selectReceiver();
      if (disposed) return;
      stage = 'prepare';
      message(`Preparing the stream for ${receiver.getCastDevice().friendlyName}…`);
      pending = await request(`/api/live/sessions/${session.id}/cast`, { lease: session.lease });
      if (disposed) {
        await revoke(pending);
        return;
      }
      const media = window.chrome.cast.media;
      const info = new media.MediaInfo(
        new URL(pending.url, origin).href,
        'application/vnd.apple.mpegurl',
      );
      info.streamType = media.StreamType.LIVE;
      info.hlsSegmentFormat = media.HlsSegmentFormat.TS;
      info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.MPEG2_TS;
      info.metadata = new media.GenericMediaMetadata();
      info.metadata.title = session.channel.name;
      stage = 'load';
      message(`Loading on ${receiver.getCastDevice().friendlyName}…`);
      const load = new media.LoadRequest(info);
      load.autoplay = true;
      await receiver.loadMedia(load);
      if (disposed) {
        receiver.endSession(true);
        await revoke(pending);
        return;
      }
      grant = pending;
      remote = new (framework().RemotePlayer)();
      controller = new (framework().RemotePlayerController)(remote);
      controller.addEventListener(framework().RemotePlayerEventType.ANY_CHANGE, render);
      button.hidden = true;
      stopButton.hidden = pauseButton.hidden = false;
      onStart();
      render();
    } catch (error) {
      await revoke(pending);
      const code = typeof error === 'string' ? error : error?.code;
      message(
        code === 'cancel'
          ? 'Casting cancelled.'
          : stage === 'prepare'
            ? error.message || 'The TV stream could not be prepared. Try again.'
            : stage === 'load'
              ? 'Could not cast: the TV could not load the stream. Check that it can reach this site, then try again.'
              : 'Could not cast: no TV connected. Check Chrome’s local network permission and use the same Wi-Fi as your TV.',
      );
    } finally {
      busy = false;
      if (!disposed) button.disabled = false;
    }
  };
  stopButton.onclick = () => {
    void stop();
  };
  pauseButton.onclick = () => controller?.playOrPause();
  return {
    get active() {
      return !!grant;
    },
    get connecting() {
      return busy;
    },
    async close() {
      disposed = true;
      selection?.fail({ code: 'cancel' });
      if (context)
        context.removeEventListener(
          framework().CastContextEventType.SESSION_STATE_CHANGED,
          disconnected,
        );
      await stop();
    },
  };
}
