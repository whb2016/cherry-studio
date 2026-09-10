/* oxlint-disable no-unused-vars */
import React, { Children, captureOwnerStack, createContext, createRef, forwardRef, lazy, useContext } from 'react'
import ReactDOM, { findDOMNode, flushSync, hydrate, render, useFormState } from 'react-dom'

const caseContextName = createContext(null)
const CaseGoodContext = createContext(null)
const caseImplicitKey = { key: 'implicit' }
const caseSpread = { title: 'spread' }

export const caseNoForwardRef = forwardRef((props: { value: string }) => <span>{props.value}</span>)

export function CaseRecommended({ children, items }: { children: React.ReactNode; items: string[] }) {
  const caseNoCreateRef = createRef<HTMLDivElement>()
  const caseNoUseContext = useContext(CaseGoodContext)
  const CaseNestedLazy = lazy(() => import('./NestedComponent'))
  const caseCaptureOwnerStack = captureOwnerStack()
  const caseFlushSync = flushSync(() => undefined)
  const caseHydrate = hydrate(<div />, document.body)
  const caseRenderReturnValue = ReactDOM.render(<div />, document.body)
  const caseNoRender = render(<div />, document.body)
  const caseUseFormState = useFormState(async () => null, null)
  findDOMNode(null)
  const caseCloneElement = React.cloneElement(<span />)

  return (
    <>
      <caseNamespace:item />
      <button>button</button>
      <iframe />
      <iframe sandbox="allow-scripts allow-same-origin" />
      <a href="javascript:void(0)" target="_blank">
        link
      </a>
      <a href="https://example.com" target="_blank">
        external
      </a>
      <div dangerouslySetInnerHTML={{ __html: 'unsafe' }}>child</div>
      <img>child</img>
      <div>// comment text</div>
      <CaseGoodContext.Provider value={null}>{children}</CaseGoodContext.Provider>
      <span {...caseSpread} key="after-spread" />
      <span {...caseImplicitKey} />
      {[<span key="duplicate" />, <span key="duplicate" />]}
      {items.map((item) => (
        <span>{item}</span>
      ))}
      {Children.count(children)}
      {Children.forEach(children, () => undefined)}
      {Children.map(children, (child) => child)}
      {Children.only(children)}
      <CaseNestedLazy />
      {caseNoCreateRef.current}
      {caseNoUseContext}
      {caseCaptureOwnerStack}
      {String(caseFlushSync)}
      {String(caseHydrate)}
      {String(caseRenderReturnValue)}
      {String(caseNoRender)}
      {String(caseUseFormState)}
      {caseCloneElement}
    </>
  )
}

CaseRecommended.defaultProps = { children: null, items: [] }
CaseRecommended.propTypes = {}
