// The "your name" field on the lobby screens. Keys typed into it stay there (they neither drive nor pick a
// vehicle), Enter or leaving the field commits, and every field shows what localStorage holds when its screen
// opens, so the vote screen and the loading screen agree.
export function bindName(input, onName) {
  const commit = () => { const name = input.value.trim().slice(0, 16); if (name && name !== localStorage.getItem("driverName")) onName(name) }
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.code === "Enter" || e.code === "Escape") input.blur() })
  input.addEventListener("keyup", (e) => e.stopPropagation())
  input.addEventListener("blur", commit)
  return { refresh: () => { input.value = localStorage.getItem("driverName") ?? "" }, blur: () => input.blur() }
}
