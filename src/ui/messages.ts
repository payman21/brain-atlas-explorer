export type MessageKind = 'error' | 'warn' | 'info'

export interface Message {
  kind: MessageKind
  text: string
  /** Rendered as a bulleted list beneath the text; truncated for long runs. */
  details?: string[]
}

const MAX_DETAILS = 6

export class MessageArea {
  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
  }

  show(messages: Message[]): void {
    this.host.replaceChildren(...messages.map((m) => this.render(m)))
  }

  clear(): void {
    this.host.replaceChildren()
  }

  private render(message: Message): HTMLElement {
    const el = document.createElement('div')
    el.className = `message ${message.kind}`
    el.append(message.text)

    if (message.details?.length) {
      const list = document.createElement('ul')
      for (const detail of message.details.slice(0, MAX_DETAILS)) {
        const li = document.createElement('li')
        li.textContent = detail
        list.append(li)
      }
      if (message.details.length > MAX_DETAILS) {
        const li = document.createElement('li')
        li.textContent = `…and ${message.details.length - MAX_DETAILS} more.`
        list.append(li)
      }
      el.append(list)
    }
    return el
  }
}
