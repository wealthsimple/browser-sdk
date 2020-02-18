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

async function newUserAction(lifeCycle: LifeCycle): Promise<{ id: string; end: number } | undefined> {
  return new Promise((resolve) => {
    let idleTimeoutId: ReturnType<typeof setTimeout>

    const { observable: changesObservable, stop } = trackPageChanges(lifeCycle)

    const validationTimeoutId = setTimeout(() => {
      resolve(undefined)
      stop()
    }, BUSY_DELAY)

    const id = generateUUID()

    changesObservable.subscribe(({ isBusy }) => {
      userActionId = id
      clearTimeout(validationTimeoutId)
      clearTimeout(idleTimeoutId)
      const end = performance.now()
      if (!isBusy) {
        idleTimeoutId = setTimeout(() => {
          stop()
          resolve({ id, end })
          userActionId = undefined
        }, IDLE_DELAY)
      }
    })
  })
}

function trackPageChanges(lifeCycle: LifeCycle): { observable: Observable<{ isBusy: boolean }>; stop(): void } {
  const result = new Observable<{ isBusy: boolean }>()
  const subscriptions: Subscription[] = []
  const pendingRequests = new Set()

  subscriptions.push(lifeCycle.subscribe(LifeCycleEventType.DOM_MUTATED, notifyChange))
  subscriptions.push(lifeCycle.subscribe(LifeCycleEventType.PERFORMANCE_ENTRY_COLLECTED, notifyChange))

  subscriptions.push(
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_COLLECTED, (requestEvent) => {
      if (requestEvent.kind === RequestEventKind.Start) {
        pendingRequests.add(requestEvent.requestId)
        notifyChange()
      } else if (pendingRequests.delete(requestEvent.requestId)) {
        notifyChange()
      }
    })
  )

  function notifyChange() {
    result.notify({ isBusy: pendingRequests.size > 0 })
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

      const userAction = await newUserAction(lifeCycle)
      if (userAction) {
        lifeCycle.notify(LifeCycleEventType.USER_ACTION_COLLECTED, {
          startTime,
          context: {
            content,
            element,
          },
          duration: userAction.end - startTime,
          id: userAction.id,
          name: 'click',
        })
      } else {
        lifeCycle.notify(LifeCycleEventType.USER_ACTION_COLLECTED, {
          startTime,
          context: {
            content,
            element,
          },
          name: 'click ignored',
        })
      }
    },
    { capture: true }
  )
}
