import { generateUUID, Observable, RequestEventKind } from '@datadog/browser-core'
import { LifeCycle, LifeCycleEventType, Subscription } from './lifeCycle'

const IDLE_DELAY = 100
const BUSY_DELAY = 100

function getElementAsString(element: Element) {
  const clone = element.cloneNode() as Element
  if (element.childNodes.length) {
    clone.appendChild(document.createTextNode('...'))
  }
  return clone.outerHTML
}

function strLengthLimit(s: string) {
  return s.length > 400 ? `${s.slice(0, 400)} [...]` : s
}

function* iterateContentCandidates(element: Element): IterableIterator<string | null> {
  yield element.textContent
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement
    const type = input.getAttribute('type')
    if (type === 'button' || type === 'submit') {
      yield input.value
    }
  }
  yield element.getAttribute('aria-label')
  yield element.getAttribute('alt')
  yield element.getAttribute('title')
  yield element.getAttribute('placeholder')

  if (element.parentElement) {
    const iterator = iterateContentCandidates(element.parentElement)
    while (true) {
      const { done, value } = iterator.next()
      if (done) {
        break
      }
      yield value
    }
  }
}

function getElementContent(element: Element) {
  const iterator = iterateContentCandidates(element)
  while (true) {
    const { done, value: content } = iterator.next()
    if (done) {
      break
    }
    if (typeof content === 'string') {
      const trimedContent = content.trim()
      if (trimedContent) {
        return strLengthLimit(trimedContent)
      }
    }
  }
  return undefined
}

enum UserActionLifecycleKind {
  Ended,
  Aborted,
  Extended,
}

interface UserActionEnded {
  kind: UserActionLifecycleKind.Ended
  id: string
  time: number
}

interface UserActionAborted {
  kind: UserActionLifecycleKind.Aborted
  id: string
  time: number
}

interface UserActionExtended {
  kind: UserActionLifecycleKind.Extended
  id: string
  time: number
  reason: string
  details?: string[]
}

type UserActionLifecycleEvent = UserActionExtended | UserActionAborted | UserActionEnded

function newUserAction(lifeCycle: LifeCycle): Observable<UserActionLifecycleEvent> {
  const result = new Observable<UserActionLifecycleEvent>()

  let idleTimeoutId: ReturnType<typeof setTimeout>
  const id = generateUUID()

  const { observable: changesObservable, stop } = trackPageChanges(lifeCycle)

  const validationTimeoutId = setTimeout(() => {
    result.notify({ id, kind: UserActionLifecycleKind.Aborted, time: performance.now() })
    stop()
  }, BUSY_DELAY)

  userActionId = id

  changesObservable.subscribe(({ isBusy, type, details }) => {
    clearTimeout(validationTimeoutId)
    clearTimeout(idleTimeoutId)
    const time = performance.now()
    result.notify({ details, id, time, kind: UserActionLifecycleKind.Extended, reason: type })
    if (!isBusy) {
      idleTimeoutId = setTimeout(() => {
        stop()
        result.notify({ id, time, kind: UserActionLifecycleKind.Ended })
        userActionId = undefined
      }, IDLE_DELAY)
    }
  })
  return result
}

interface ChangeEvent {
  isBusy: boolean
  type: string
  details?: string[]
}
function trackPageChanges(lifeCycle: LifeCycle): { observable: Observable<ChangeEvent>; stop(): void } {
  const result = new Observable<ChangeEvent>()
  const subscriptions: Subscription[] = []
  const pendingRequests = new Map()

  subscriptions.push(lifeCycle.subscribe(LifeCycleEventType.DOM_MUTATED, () => notifyChange('dom_mutated')))
  subscriptions.push(
    lifeCycle.subscribe(LifeCycleEventType.PERFORMANCE_ENTRY_COLLECTED, (entry) => {
      if (entry.entryType !== 'resource') {
        return
      }

      const details = []
      if ('initiatorType' in entry) {
        details.push(`initiatorType: ${(entry as PerformanceResourceTiming).initiatorType}`)
      }
      if (entry.name) {
        details.push(`name: ${entry.name}`)
      }
      notifyChange('performance_entry_collected', details)
    })
  )

  subscriptions.push(
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_COLLECTED, (requestEvent) => {
      if (requestEvent.kind === RequestEventKind.Start) {
        pendingRequests.set(requestEvent.requestId, requestEvent.details)
        notifyChange('request_start', [`Url: ${requestEvent.details.url}`])
      } else if (pendingRequests.delete(requestEvent.requestId)) {
        notifyChange('request_end', [`Url: ${requestEvent.details.url}`])
      }
    })
  )

  function notifyChange(type: string, details?: string[]) {
    result.notify({ type, details, isBusy: pendingRequests.size > 0 })
  }

  return {
    observable: result,
    stop() {
      subscriptions.forEach((s) => s.unsubscribe())
    },
  }
}

let userActionId: string | undefined

export function getUserActionId() {
  return userActionId
}

export function startUserActionCollection(lifeCycle: LifeCycle) {
  addEventListener(
    'click',
    async (event) => {
      let element: string | undefined
      let content: string | undefined
      if (event.target instanceof Element) {
        element = getElementAsString(event.target) || undefined
        content = getElementContent(event.target)
      }
      const startTime = performance.now()

      newUserAction(lifeCycle).subscribe((lifeCycleEvent) => {
        console.log(lifeCycleEvent.kind, lifeCycleEvent.time - startTime)
        switch (lifeCycleEvent.kind) {
          case UserActionLifecycleKind.Aborted:
            lifeCycle.notify(LifeCycleEventType.USER_ACTION_COLLECTED, {
              startTime,
              context: {
                content,
                element,
              },
              name: 'click ignored',
              userActionId: lifeCycleEvent.id,
            })
            break
          case UserActionLifecycleKind.Extended:
            lifeCycle.notify(LifeCycleEventType.USER_ACTION_COLLECTED, {
              context: {
                details: lifeCycleEvent.details,
                reason: lifeCycleEvent.reason,
              },
              duration: 0,
              name: 'click extended',
              startTime: lifeCycleEvent.time,
              userActionId: lifeCycleEvent.id,
            })
            break
          case UserActionLifecycleKind.Ended:
            lifeCycle.notify(LifeCycleEventType.USER_ACTION_COLLECTED, {
              startTime,
              context: {
                content,
                element,
              },
              duration: lifeCycleEvent.time - startTime,
              id: lifeCycleEvent.id,
              name: 'click',
            })
            break
        }
      })
    },
    { capture: true }
  )
}
