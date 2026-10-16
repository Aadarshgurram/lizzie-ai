import { useEffect, useRef, useState } from "react";

// Always-on "Hey Lizzie" using the browser's built-in speech recognition (Chrome / Edge / Safari).
// It reacts the moment it hears the wake phrase, exposes the live transcript (`heard`) so the UI can
// show a listening popup, and exposes a persistent `notice` whenever something blocks it (mic denied,
// no internet, unsupported browser, waiting for a first click) so it never fails silently.
export const SpeechRec = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const voiceSupported = !!SpeechRec && typeof window !== "undefined" && "speechSynthesis" in window;

// Speech engines often mishear an unusual name like "Lizzie" (Lisi, Lizzy, Lissy, "a Lizzie"...), so
// matching is deliberately forgiving:
//  - STRICT: any spelling that sounds like Lizzie, allowed as the 1st-3rd word ("Lizzie, ...",
//    "hey lizzie", "hey there lizzie", "a lizzie", "heylizzie"). Command = everything after it.
//  - LOOSE: other near-names (Liz, Lisa, Elise, Elizabeth) only right after a greeting.
const NAME = "l[iey]{1,2}[sz]{1,2}[iey]{1,2}";
const WAKE_STRICT = new RegExp(`^\\W*(?:\\w+\\W+){0,2}?(?:(?:hey|hay|hi|ok|okay)\\s*)?${NAME}\\b[\\s,.!?:;-]*`, "i");
const WAKE_LOOSE = /^\W*(?:hey|hay|hi|hello|ok|okay|okey|he|ay)[\s,]+(?:liz|lisa|lis|elise|elizabeth)\b[\s,.!?:;-]*/i;
export const matchWake = (t) => t.match(WAKE_STRICT) || t.match(WAKE_LOOSE);
const COMMAND_WINDOW_MS = 8000; // after "Hey Lizzie" alone, how long to wait for the command
const MAX_SPOKEN_CHARS = 450;
const PREF_KEY = "chat.voice";

// Listening is ON by default; the header button turns it off (and remembers that choice).
const savedPref = () => {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};
const savePref = (on) => {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {}
};

// English variants recognise Indian-accented speech better with en-IN.
export const recogLang = () => {
  const l = navigator.language || "en-US";
  return l.toLowerCase().startsWith("en") ? "en-IN" : l;
};

async function micState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state; // granted | prompt | denied
  } catch {
    return "prompt";
  }
}

function beep(freq) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 120);
  } catch {}
}

// Make a reply sound natural when read aloud: no markdown, code skipped, long replies trimmed.
function prepareSpeech(text) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > MAX_SPOKEN_CHARS) {
    const cut = t.slice(0, MAX_SPOKEN_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = (end > 120 ? cut.slice(0, end + 1) : cut) + " The rest is on screen.";
  }
  return t;
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  const lang = (navigator.language || "en-US").toLowerCase();
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
  return (
    sameLang.find((v) => /female|zira|samantha|aria|jenny|natural|google/i.test(v.name)) ||
    sameLang.find((v) => v.lang.toLowerCase() === lang) ||
    sameLang[0] ||
    null
  );
}

export function useVoice({ onCommand }) {
  const [enabled, setEnabled] = useState(false); // wake-word listening switched on
  const [phase, setPhase] = useState("off"); // off | waiting | capturing | speaking
  const [heard, setHeard] = useState(""); // live transcript of the command being spoken
  const [notice, setNotice] = useState(""); // persistent explanation when voice can't run
  const [lastHeard, setLastHeard] = useState(""); // what the recognizer last heard while waiting (for troubleshooting)

  const recRef = useRef(null);
  const enabledRef = useRef(false);
  const modeRef = useRef("waiting"); // waiting | capturing (next sentence is the command)
  const awakeIdx = useRef(-1); // index of the utterance in which the wake phrase was heard
  const pausedRef = useRef(false); // true while Lizzie is speaking, so she doesn't hear herself
  const holdRef = useRef(false); // true while another feature (dictation) needs the microphone
  const langRef = useRef(null);
  const capTimer = useRef(null);
  const retryDelay = useRef(100);
  const logRef = useRef([]); // last few finished phrases, shown in the status line for troubleshooting
  const startRef = useRef(() => {});
  const uttRef = useRef(null); // the utterance currently being spoken (ignores events from cancelled ones)
  const cb = useRef({});
  cb.current = { onCommand };

  const idlePhase = () => (enabledRef.current ? "waiting" : "off");
  const canListen = () => enabledRef.current && !pausedRef.current && !holdRef.current;

  function beginCapture() {
    modeRef.current = "capturing";
    setPhase("capturing");
    clearTimeout(capTimer.current);
    capTimer.current = setTimeout(endCapture, COMMAND_WINDOW_MS);
  }

  function endCapture() {
    clearTimeout(capTimer.current);
    modeRef.current = "waiting";
    setHeard("");
    if (!pausedRef.current) setPhase(idlePhase());
  }

  // Used by the popup's Cancel button.
  function cancelCapture() {
    awakeIdx.current = -1;
    endCapture();
  }

  function fire(command) {
    endCapture();
    if (command) cb.current.onCommand?.(command);
  }

  // Called for interim AND final results, so the wake phrase is noticed as soon as it is spoken.
  function handleResult(i, text, isFinal) {
    const m = matchWake(text);

    // A sentence after a bare "Hey Lizzie" is the command.
    if (modeRef.current === "capturing" && !m && awakeIdx.current !== i) {
      setHeard(text);
      if (isFinal) fire(text);
      return;
    }
    // First time we hear the wake phrase in this utterance: react immediately.
    if (m && awakeIdx.current !== i) {
      awakeIdx.current = i;
      beep(880);
      beginCapture();
    }
    if (awakeIdx.current === i) {
      const command = m ? text.slice(m.index + m[0].length).trim() : "";
      setHeard(command);
      if (isFinal) {
        awakeIdx.current = -1;
        if (command) fire(command); // "Hey Lizzie, what's the time"
        else beginCapture(); // just "Hey Lizzie": wait for the next sentence
      }
    }
  }

  startRef.current = () => {
    if (!SpeechRec || recRef.current || !canListen()) return;
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = langRef.current || recogLang();
    awakeIdx.current = -1; // result indexes restart with every new recognition session
    rec.onaudiostart = () => setNotice(""); // the mic is really open, so any earlier problem is gone
    rec.onresult = (ev) => {
      if (recRef.current !== rec || pausedRef.current) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const text = ev.results[i][0].transcript.trim();
        if (modeRef.current === "waiting") {
          const short = text.slice(-35);
          if (ev.results[i].isFinal) {
            logRef.current = [...logRef.current, short].slice(-3);
            setLastHeard(logRef.current.join(" | "));
          } else {
            setLastHeard([...logRef.current.slice(-2), short].join(" | "));
          }
        }
        handleResult(i, text, ev.results[i].isFinal);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setNotice("Microphone is blocked. Click the 🔒 next to the address bar, allow the microphone, then click Hey Lizzie.");
        stopAll();
      } else if (e.error === "audio-capture") {
        setNotice("No microphone was found.");
        stopAll();
      } else if (e.error === "network") {
        setNotice("Can't reach the speech service. Hands-free needs internet, and Chrome or Edge (not Brave).");
        retryDelay.current = 5000;
      } else if (e.error === "language-not-supported") {
        langRef.current = "en-US";
      }
    };
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      // Browsers end recognition on silence or after a while, so quietly start it again.
      if (canListen()) setTimeout(() => startRef.current(), retryDelay.current);
    };
    try {
      recRef.current = rec;
      rec.start();
      retryDelay.current = 100;
    } catch {
      if (recRef.current === rec) recRef.current = null;
    }
  };

  function stopRec() {
    const rec = recRef.current;
    recRef.current = null;
    try {
      rec?.abort();
    } catch {}
  }

  function stopAll() {
    enabledRef.current = false;
    pausedRef.current = false;
    uttRef.current = null;
    modeRef.current = "waiting";
    clearTimeout(capTimer.current);
    try {
      window.speechSynthesis.cancel();
    } catch {}
    stopRec();
    setEnabled(false);
    setPhase("off");
    setHeard("");
  }

  function turnOn() {
    enabledRef.current = true;
    modeRef.current = "waiting";
    setEnabled(true);
    setPhase("waiting");
    startRef.current();
  }

  // Header button: turn listening off/on and remember the choice. A click also satisfies the
  // browser's "needs a user gesture" rule, so this is the reliable way to (re)start it.
  function toggle() {
    if (enabledRef.current) {
      savePref(false);
      setNotice("");
      stopAll();
    } else {
      savePref(true);
      setNotice("");
      turnOn();
    }
  }

  // Other features (e.g. the message-box mic) borrow the microphone: pause/resume wake listening.
  function suspend(on) {
    holdRef.current = on;
    if (on) stopRec();
    else startRef.current();
  }

  function finishSpeaking() {
    pausedRef.current = false;
    setPhase(idlePhase());
    startRef.current();
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    const t = prepareSpeech(text);
    if (!t) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = 1.05;
    pausedRef.current = true;
    setPhase("speaking");
    stopRec(); // don't hear ourselves
    u.onend = () => {
      if (uttRef.current !== u) return; // a newer utterance replaced this one
      uttRef.current = null;
      finishSpeaking();
    };
    u.onerror = (e) => {
      if (uttRef.current !== u) return;
      uttRef.current = null;
      if (e.error === "not-allowed") setNotice("Click anywhere on the page once so I'm allowed to speak.");
      finishSpeaking();
    };
    uttRef.current = u;
    window.speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (!pausedRef.current) return;
    uttRef.current = null;
    try {
      window.speechSynthesis.cancel();
    } catch {}
    finishSpeaking();
  }

  // Start automatically when the app opens. Browsers only let a page open the mic without a click if
  // the site already has permission; otherwise we wait for the first click anywhere on the page.
  useEffect(() => {
    let cancelled = false;
    let removeGesture = () => {};
    (async () => {
      if (!voiceSupported) {
        setNotice("Hands-free voice needs Chrome, Edge or Safari (not Firefox or Brave).");
        return;
      }
      if (!savedPref()) return;
      const state = await micState();
      if (cancelled) return;
      if (state === "denied") {
        setNotice("Microphone is blocked for this site. Click the 🔒 next to the address bar, allow it, then refresh.");
        return;
      }
      if (state === "granted") return turnOn();
      setNotice("Click anywhere to enable “Hey Lizzie”");
      const go = () => {
        removeGesture();
        if (!enabledRef.current && savedPref()) {
          setNotice("");
          turnOn();
        }
      };
      window.addEventListener("pointerdown", go, true);
      window.addEventListener("keydown", go, true);
      removeGesture = () => {
        window.removeEventListener("pointerdown", go, true);
        window.removeEventListener("keydown", go, true);
      };
    })();
    return () => {
      cancelled = true;
      removeGesture();
      stopAll();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { supported: voiceSupported, enabled, phase, heard, notice, lastHeard, toggle, speak, stopSpeaking, suspend, cancelCapture };
}
