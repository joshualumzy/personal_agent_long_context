// Shows what a screen share gives this page: which surface, and whether audio comes with it.
let stream = null;
let context = null;
let loudest = 0;

async function start() {
  context = new AudioContext();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" });
  } catch (error) {
    document.getElementById("kind").textContent = `没共享成功：${error.message}`;
    return;
  }
  await context.resume();
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  const surface = video?.getSettings().displaySurface ?? "unknown";
  const names = { monitor: "整个屏幕", window: "窗口", browser: "标签页" };
  document.getElementById("kind").textContent =
    `共享的是：${names[surface] ?? surface}；音频轨道：${audio ? `有（${audio.label || "无名称"}）` : "没有"}`;
  document.getElementById("start").disabled = true;
  document.getElementById("stop").disabled = false;
  for (const track of stream.getTracks()) track.addEventListener("ended", stop);
  if (!audio) {
    document.getElementById("verdict").textContent = "这次共享没有带声音。选整个屏幕时要打开系统音频开关；如果没有这个开关，说明这台电脑上的 Chrome 不给系统声音。";
    return;
  }
  const tap = context.createScriptProcessor(4096, 1, 1);
  context.createMediaStreamSource(new MediaStream([audio])).connect(tap);
  tap.connect(context.destination);
  tap.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const level = Math.min(1, Math.sqrt(sum / samples.length) * 8);
    loudest = Math.max(loudest, level);
    document.getElementById("bar").style.width = `${Math.round(level * 100)}%`;
    document.getElementById("verdict").textContent = loudest > 0.05 ? "收到声音了 ✓" : "有音频轨道，但还没听到声音，放点有声音的东西试试。";
  };
}

function stop() {
  for (const track of stream?.getTracks() ?? []) track.stop();
  context?.close();
  stream = null;
  context = null;
  document.getElementById("start").disabled = false;
  document.getElementById("stop").disabled = true;
  document.getElementById("bar").style.width = "0";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("start").addEventListener("click", start);
  document.getElementById("stop").addEventListener("click", stop);
});
