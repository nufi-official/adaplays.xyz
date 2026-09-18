import { Blockfrost, Lucid, WalletApi, UTxO, Script, Address, Data, PlutusData, Constr, getAddressDetails, TxComplete } from "lucid-cardano"
import { SupportedWallets } from "types/types"

export const getApi = async (walletName: SupportedWallets) => (await window.cardano[walletName].enable())

export const getWalletBech32Address = async (api: WalletApi) => {
  const used = await api.getUsedAddresses()
  const unused = await api.getUnusedAddresses()
  const raw = used?.[0] || unused?.[0] || await api.getChangeAddress()
  if (!raw) {
    throw new Error("Wallet did not return an address")
  }
  return getAddressDetails(raw).address.bech32
}

// Lucid 0.7.6's CML only accepts Alonzo/Vasil cost-model sizes. Current Preprod
// Conway params have 332/350 ops and throw "CostModel operation 166 out of bounds".
const CML_PLUTUS_V1_OPS = 166
const CML_PLUTUS_V2_OPS = 175

const toCmlCostModel = (raw: number[] | undefined, named: Record<string, number> | undefined, maxOps: number) => {
  const values = Array.isArray(raw) ? raw : Object.values(named || {})
  return Object.fromEntries(values.slice(0, maxOps).map((cost, index) => [index, Number(cost)]))
}

class LucidBlockfrost extends Blockfrost {
  async getProtocolParameters() {
    const result = await fetch(`${this.url}/epochs/latest/parameters`, {
      headers: { project_id: this.projectId },
    }).then((res) => res.json())
    if (result.error) {
      throw new Error(result.message || "Could not fetch protocol parameters from Blockfrost")
    }
    return {
      minFeeA: parseInt(result.min_fee_a),
      minFeeB: parseInt(result.min_fee_b),
      maxTxSize: parseInt(result.max_tx_size),
      maxValSize: parseInt(result.max_val_size),
      keyDeposit: BigInt(result.key_deposit),
      poolDeposit: BigInt(result.pool_deposit),
      priceMem: parseFloat(result.price_mem),
      priceStep: parseFloat(result.price_step),
      maxTxExMem: BigInt(result.max_tx_ex_mem),
      maxTxExSteps: BigInt(result.max_tx_ex_steps),
      coinsPerUtxoByte: BigInt(result.coins_per_utxo_size),
      collateralPercentage: parseInt(result.collateral_percent),
      maxCollateralInputs: parseInt(result.max_collateral_inputs),
      costModels: {
        PlutusV1: toCmlCostModel(result.cost_models_raw?.PlutusV1, result.cost_models?.PlutusV1, CML_PLUTUS_V1_OPS),
        PlutusV2: toCmlCostModel(result.cost_models_raw?.PlutusV2, result.cost_models?.PlutusV2, CML_PLUTUS_V2_OPS),
      },
    }
  }
}

type LucidWithCip30 = Lucid & { cip30: WalletApi }

export const getLucid = async (walletName: SupportedWallets) => {
  const api: WalletApi = await getApi(walletName)
  const lucid = await Lucid.new(
    new LucidBlockfrost("/api/blockfrost/0", ""),  // project-id header will be set by redirect
    "Preprod"
  ) as LucidWithCip30
  lucid.selectWallet(api)
  // Lucid 0.7.6 only uses getUsedAddresses()[0], which is empty for unused SSO wallets.
  lucid.wallet.address = async () => getWalletBech32Address(api)
  lucid.cip30 = api
  return lucid
}

const postConwayTx = async (body: { tx: string, witnesses?: string }) => {
  const res = await fetch("/api/conway-script-hash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.tx !== "string") {
    throw new Error(data.error || "Could not recompute Conway script integrity hash")
  }
  return data as { tx: string, originalHash?: string | null, newHash?: string | null }
}

export const submitLucidTx = async (lucid: Lucid, tx: TxComplete) => {
  const api = (lucid as LucidWithCip30).cip30
  if (!api) {
    throw new Error("Wallet API is not available")
  }
  // Do not round-trip the patched body through Lucid 0.7.6; it re-encodes the old hash.
  const patched = await postConwayTx({ tx: tx.toString() })
  if (patched.originalHash && patched.newHash && patched.originalHash === patched.newHash) {
    throw new Error("Conway script hash patch did not change the integrity hash")
  }
  const witnesses = await api.signTx(patched.tx, true)
  const assembled = await postConwayTx({ tx: patched.tx, witnesses })
  return api.submitTx(assembled.tx)
}

// Aim is to get the utxo with least number of assets and most lovelaces.
export const getDesiredUtxo = async (lucid: Lucid) => {
  const playerAAdress = await lucid.wallet.address()
  const aUtxos = await lucid.utxosAt(playerAAdress)
  if (aUtxos.length === 0) {
    throw "Wallet is empty!"
  } else {
    let desiredUtxo: UTxO = aUtxos[0]
    let currentDesiredAssetsLen = Object.keys(desiredUtxo.assets).length
    for (let i = 1; i < aUtxos.length; i++) {
      let currentAssetsLen = Object.keys(aUtxos[i].assets).length
      if (currentAssetsLen > currentDesiredAssetsLen) continue;
      if (currentAssetsLen === currentDesiredAssetsLen && aUtxos[i].assets['lovelace'] > desiredUtxo.assets['lovelace']) {
        desiredUtxo = aUtxos[i]
        continue
      } else if (currentAssetsLen < currentDesiredAssetsLen) {
        currentDesiredAssetsLen = currentAssetsLen
        desiredUtxo = aUtxos[i]
      }
    }
    return desiredUtxo
  }
}

export const addScript = async (lucid: Lucid, address: Address, script: Script) => {
  const tx = await lucid
    .newTx()
    .payToContract(address, { asHash: Data.empty(), scriptRef: script}, {})
    .complete()
  return submitLucidTx(lucid, tx)
}

export const getConstr = (data: PlutusData): Constr<PlutusData>  => {
  if (data instanceof Constr<PlutusData>) {
    return data
  } else {
    throw "Not of type Constr<PlutusData>"
  }
}
