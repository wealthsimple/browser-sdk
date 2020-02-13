import { LifeCycle, LifeCycleEventType } from './lifeCycle'

let hasStarted = false

export function startDOMMutationCollection(lifeCycle: LifeCycle) {
  if (!hasStarted) {
    const observer = new MutationObserver(() => {
      lifeCycle.notify(LifeCycleEventType.DOM_MUTATED)
    })

    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    hasStarted = true
  }
}
