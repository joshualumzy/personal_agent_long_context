"use strict";

// The foot of the shared sidebar on pages that do not run the assistant's
// own script: who is signed in, shown by their initial, and a way out.

function shellAvatar(box, employee) {
  box.textContent = ((employee?.displayName || "?").trim()[0] || "?").toUpperCase();
}

async function loadShellUser() {
  const foot = document.querySelector(".shell-user");
  if (!foot) return;
  let employee = null;
  try {
    const response = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
    if (response.ok) employee = (await response.json()).employee ?? null;
  } catch {
    // Signed-out is shown below.
  }
  shellAvatar(foot.querySelector(".shell-avatar"), employee);
  foot.querySelector(".shell-name").textContent = employee ? employee.displayName : "Signed out";
  foot.querySelector(".shell-role").textContent = employee ? employee.role || employee.department || "" : "Sign in on the assistant page";
  const out = foot.querySelector(".shell-out");
  out.hidden = !employee;
  out.onclick = async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    location.href = "/";
  };
}

loadShellUser();
