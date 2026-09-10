/* oxlint-disable no-unused-vars */
import { useEffect } from 'react'

export function CaseLeakedResources() {
  useEffect(() => {
    const caseLeakedInterval = setInterval(() => undefined, 100)
    const caseLeakedResizeObserver = new ResizeObserver(() => undefined)
    caseLeakedResizeObserver.observe(document.body)
  }, [])

  return null
}
