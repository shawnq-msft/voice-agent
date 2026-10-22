// Run in a loaded cockpit page with agent-browser eval --stdin.
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const $ = (selector) => document.querySelector(selector);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
  const button = $("#connect");
  const card = $(".assistant-card");
  const orb = $(".voice-orb");
  const inspector = $(".pipeline-inspector");
  const { processEvent } = await import("/static/app.js");
  assert(document.title === "Azure Voice Agent for Cars / AURA", "Browser title");
  assert($("h1").textContent === "Azure Voice Agent for Cars", "Banner title");
  assert($("header .process-card"), "Pipeline must be in the banner");
  assert(!inspector.open, "Inspector starts collapsed");
  assert($(".site-header").getBoundingClientRect().height < 350, "Compact header height");
  assert(document.documentElement.scrollWidth <= innerWidth, "No horizontal overflow");
  assert($(".process-steps").children.length === 6, "All six pipeline stages preserved");
  inspector.open = true;
  processEvent({ turn: 1, stage: "searching", detail: "Searching local tools", arguments: '{"query":"temperature"}' });
  assert($('[data-step="searching"]').dataset.state === "active", "Search stage active");
  assert($("#process-query").textContent.includes("temperature"), "Search request retained");
  processEvent({ turn: 1, stage: "discovered", detail: "Tool found", result: {
    ok: true, matches: [{ name: "get_vehicle_status", description: "Read vehicle state", parameters: {} }],
  } });
  assert($("#process-matches summary").textContent === "get_vehicle_status", "Expandable tool schema retained");
  processEvent({ turn: 1, stage: "executing", detail: "Executing", name: "get_vehicle_status", arguments: "{}" });
  processEvent({ turn: 1, stage: "result", detail: "Done", name: "get_vehicle_status", result: { ok: true } });
  processEvent({ turn: 1, stage: "complete", detail: "Response ready" });
  assert($("#process-pill").textContent.includes("RESPONSE READY"), "Pipeline completion retained");
  inspector.open = false;

  const originals = {
    AudioContext: window.AudioContext, AudioWorkletNode: window.AudioWorkletNode,
    WebSocket: window.WebSocket, getUserMedia: navigator.mediaDevices.getUserMedia,
    disabled: button.disabled,
  };
  const originalBackground = getComputedStyle(orb).backgroundImage;
  const node = () => ({ connect() {}, disconnect() {} });
  let socket;
  let holdMicrophone = false;
  let resolveMicrophone;
  const stream = { getTracks: () => [{ stop() {} }] };
  class TestContext {
    sampleRate = 24000;
    state = "running";
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = async () => {};
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: { value: 0 } });
  }
  class TestSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() { socket = this; }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    message(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  try {
    window.AudioContext = TestContext;
    window.AudioWorkletNode = class { port = {}; connect() {} disconnect() {} };
    window.WebSocket = TestSocket;
    navigator.mediaDevices.getUserMedia = () => holdMicrophone
      ? new Promise((resolve) => { resolveMicrophone = resolve; }) : Promise.resolve(stream);
    button.disabled = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    assert(getComputedStyle(button).animationName === (reduced ? "none" : "connectBreathe"), "Idle button breathing respects reduced motion");
    if (!reduced) {
      const animation = button.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
      const dark = getComputedStyle(button).backgroundColor;
      animation.currentTime = 2400;
      assert(getComputedStyle(button).backgroundColor !== dark, "Button alternates dark and light");
      animation.play();
    }
    button.click();
    await wait();
    assert(card.classList.contains("connecting"), "Connection starts");
    assert(getComputedStyle(button).animationName === "none", "Breathing stops while connecting");
    assert(getComputedStyle(orb).backgroundImage === originalBackground, "Connecting orb stays purple");
    socket.message({ type: "ready" });
    assert(card.classList.contains("connected"), "Ready state connected");
    assert(getComputedStyle(orb).backgroundImage !== originalBackground, "Connected orb becomes teal");
    assert($("#agent-visual").getAttribute("aria-label").includes("connected and active"), "Accessible connected label");
    assert(getComputedStyle(orb).animationName === (reduced ? "none" : "agentBreathe"), "Connected orb respects reduced motion");
    button.click();
    assert(!card.classList.contains("connected"), "Disconnect clears connected state");
    assert(getComputedStyle(orb).backgroundImage === originalBackground, "Disconnect restores purple");
    button.click();
    await wait();
    socket.message({ type: "error", message: "Test connection failure" });
    assert(!card.classList.contains("connecting") && !card.classList.contains("connected"), "Error clears connection state");
    assert(getComputedStyle(orb).backgroundImage === originalBackground, "Error restores purple");
    holdMicrophone = true;
    button.click();
    await wait();
    button.click();
    resolveMicrophone(stream);
    await wait();
    assert(!card.classList.contains("connecting"), "Cancelling microphone request restores idle state");
    assert($("#agent-visual").getAttribute("aria-label") === "AI agent disconnected", "Accessible disconnected label");
  } finally {
    if (card.classList.contains("connected") || card.classList.contains("connecting")) button.click();
    window.AudioContext = originals.AudioContext;
    window.AudioWorkletNode = originals.AudioWorkletNode;
    window.WebSocket = originals.WebSocket;
    navigator.mediaDevices.getUserMedia = originals.getUserMedia;
    button.disabled = originals.disabled;
    $("#error").hidden = true;
  }
  return `UI checks passed at ${innerWidth}px (${matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "normal"} motion)`;
})()
