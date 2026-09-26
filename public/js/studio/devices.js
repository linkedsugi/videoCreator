const STORE_KEY = 'vc.devices';

export function loadDevicePrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveDevicePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: preferences just aren't remembered
  }
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cams: all.filter((d) => d.kind === 'videoinput' && d.deviceId),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId),
  };
}

/**
 * Camera + microphone. Echo cancellation and auto gain are off: they color
 * the voice, and loudness is evened out when the video is made.
 */
export async function openCamera({ camId, micId, noiseSuppression = true }) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: camId ? { exact: camId } : undefined,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression,
      sampleRate: { ideal: 48000 },
    },
  });
}

/**
 * Asks the user to pick the Chrome tab used for demos. Only that tab is
 * recorded (with its sound), so the prompter window, notifications and other
 * apps never appear in the video.
 */
export async function openScreen() {
  const controller = typeof CaptureController === 'function' ? new CaptureController() : null;
  const options = {
    video: { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: { suppressLocalAudioPlayback: false },
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    preferCurrentTab: false,
  };
  if (controller) options.controller = controller;
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  try {
    // Stay on the studio page instead of jumping to the shared tab.
    controller?.setFocusBehavior('no-focus-change');
  } catch {
    // not supported for this surface
  }
  return stream;
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function describeVideo(stream) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return '';
  const s = track.getSettings();
  return s.width ? `${s.width}×${s.height}${s.frameRate ? ` · ${Math.round(s.frameRate)}fps` : ''}` : '';
}

/** Microphone level for the meter: calls onLevel(0..1, clipping) every frame. */
export class LevelMeter {
  constructor(stream, onLevel) {
    this.onLevel = onLevel;
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    let sum = 0;
    for (const v of this.buf) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this.onLevel(Math.min(1, Math.max(0, (db + 60) / 60)), peak > 0.98);
    this.raf = requestAnimationFrame(this.tick);
  }

  resume() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.source.disconnect();
    this.ctx.close();
  }
}
