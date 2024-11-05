import { Button } from '@chakra-ui/react'
import { initNufiDappCardanoSdk } from '@nufi/dapp-client-cardano'
import nufiCoreSdk from '@nufi/dapp-client-core'
import React from 'react'

function TestScreen() {
  return (
    <div>
      <TestWeb3AuthIsEnabled />
      <TestMetadataIsEnabled />
    </div>
  )
}

function TestWeb3AuthIsEnabled() {
  return <Button margin={2} onClick={async () => {
      initNufiDappCardanoSdk(nufiCoreSdk, 'sso')
      alert(await window.cardano.nufiSSO.isEnabled())
  }}>Testing: SSO: isEnabled</Button>
}

function TestMetadataIsEnabled() {
  return <Button margin={2} onClick={async () => {
      initNufiDappCardanoSdk(nufiCoreSdk, 'snap')
      alert(await window.cardano.nufiSnap.isEnabled())
  }}>Testing: Snap: isEnabled</Button>
}

export default TestScreen
