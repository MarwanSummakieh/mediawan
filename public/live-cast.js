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
    if (!ownsReceiver()) {
      void stop(false);
      return;
    }
    pauseButton.textContent = remote.isPaused ? 'Play on TV' : 'Pause TV';
    message(
      `${remote.isPaused ? 'Paused' : 'Playing'} on ${receiver.getCastDevice().friendlyName}`,
    );
  };
  const disconnected = (event) => {
    if (event.sessionState === framework().SessionState.SESSION_ENDED && grant) void stop(false);
  };
  async function stop(endReceiver = true) {
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
      message('');
      onStop();
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
    let pending;
    try {
      // Device discovery must start directly inside the user's click handler.
      await context.requestSession();
      if (disposed) return;
      receiver = context.getCurrentSession();
      if (!receiver) throw Error('No TV connected. Try casting again.');
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
      await receiver.loadMedia(new media.LoadRequest(info));
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
      message(
        error === 'cancel' || error?.code === 'cancel'
          ? 'Casting cancelled.'
          : 'Could not cast. Check that Chrome and your TV are on the same Wi-Fi, then try again.',
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
    async close() {
      disposed = true;
      if (context)
        context.removeEventListener(
          framework().CastContextEventType.SESSION_STATE_CHANGED,
          disconnected,
        );
      await stop();
    },
  };
}
