// idle-guard.js
const idleTimers = new Map()

/**
 * Activa un timer de inactividad para un usuario
 */
export function armIdleGuard(ctx, gotoFlow, targetFlow, ms = 600000) {
  const user = ctx.from
  if (idleTimers.has(user)) clearTimeout(idleTimers.get(user))

  const timer = setTimeout(() => {
    console.log(`[idle] ${user} → flowDespedida`)
    gotoFlow(targetFlow)
    idleTimers.delete(user)
  }, ms)

  idleTimers.set(user, timer)
}

/**
 * Cancela el timer si el usuario respondió
 */
export function disarmIdleGuard(ctx) {
  const user = ctx.from
  if (idleTimers.has(user)) {
    clearTimeout(idleTimers.get(user))
    idleTimers.delete(user)
  }
}
