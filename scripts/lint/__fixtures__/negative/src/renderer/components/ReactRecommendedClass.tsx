/* oxlint-disable no-unused-vars */
import React from 'react'

export class CaseLegacyComponent extends React.Component {
  state = { count: 0 }
  unusedMember() {}

  componentDidMount() {
    this.setState({ count: 1 })
  }

  componentDidUpdate() {
    this.setState({ count: 2 })
  }

  componentWillMount() {}
  componentWillReceiveProps() {}
  componentWillUpdate() {
    this.setState({ count: 3 })
  }

  UNSAFE_componentWillMount() {}
  UNSAFE_componentWillReceiveProps() {}
  UNSAFE_componentWillUpdate() {}

  updateFromCurrentState() {
    this.setState({ count: this.state.count + 1 })
  }

  mutateStateDirectly() {
    this.state.count = 4
  }

  render() {
    return <div ref="legacy-ref" />
  }
}

export class CaseRedundantUpdate extends React.PureComponent {
  shouldComponentUpdate() {
    return true
  }

  render() {
    return null
  }
}

export class CaseUnusedState extends React.Component {
  state = { unused: true }

  render() {
    return null
  }
}
