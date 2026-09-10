import React, { createContext, createRef, useEffect, useRef } from 'react'

export const CaseContext = createContext<string | null>(null)

export function CaseRecommended({ label = 'ready' }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const interval = setInterval(() => undefined, 100)
    const observer = new ResizeObserver(() => undefined)
    observer.observe(document.body)
    return () => {
      clearInterval(interval)
      observer.disconnect()
    }
  }, [])

  return (
    <CaseContext value={label}>
      <button type="button">{label}</button>
      <iframe ref={ref} sandbox="" title={label} />
    </CaseContext>
  )
}

export class CaseClass extends React.Component {
  state = { ready: true }
  field = createRef<HTMLDivElement>()

  readField() {
    return this.field
  }

  render() {
    return this.state.ready ? <div ref={this.readField()} /> : null
  }
}
