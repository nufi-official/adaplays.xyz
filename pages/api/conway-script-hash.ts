import type { NextApiHandler } from "next"
import * as CML from "@anastasia-labs/cardano-multiplatform-lib-nodejs"

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
}

const costModelsFromRaw = (raw: { PlutusV1?: number[], PlutusV2?: number[], PlutusV3?: number[] }) => {
  // RPS scripts are PlutusV2. Including only used languages matches the ledger language view.
  const models: Record<string, number[]> = {}
  if (raw.PlutusV1?.length) models["0"] = raw.PlutusV1
  if (raw.PlutusV2?.length) models["1"] = raw.PlutusV2
  if (raw.PlutusV3?.length) models["2"] = raw.PlutusV3
  return CML.CostModels.from_json(JSON.stringify(models))
}

const hashHex = (hash?: CML.ScriptDataHash | null) => hash ? hash.to_hex() : null

const usedLanguages = (ws: CML.TransactionWitnessSet) => {
  const langs = CML.LanguageList.new()
  const fromWitness = ws.languages()
  if (fromWitness.len() > 0) return fromWitness
  if (ws.plutus_v1_scripts() && ws.plutus_v1_scripts()!.len() > 0) langs.add(CML.Language.PlutusV1)
  if (ws.plutus_v2_scripts() && ws.plutus_v2_scripts()!.len() > 0) langs.add(CML.Language.PlutusV2)
  if (ws.plutus_v3_scripts() && ws.plutus_v3_scripts()!.len() > 0) langs.add(CML.Language.PlutusV3)
  if (langs.len() === 0 && ws.redeemers()) langs.add(CML.Language.PlutusV2)
  return langs
}

const computeScriptDataHash = (ws: CML.TransactionWitnessSet, costModels: CML.CostModels) => {
  const fromWitness = CML.calc_script_data_hash_from_witness(ws, costModels)
  if (fromWitness) return fromWitness
  const redeemers = ws.redeemers()
  if (!redeemers) return undefined
  const datums = ws.plutus_datums() || CML.PlutusDataList.new()
  return CML.calc_script_data_hash(redeemers, datums, costModels, usedLanguages(ws))
    || CML.hash_script_data(redeemers, costModels, ws.plutus_datums())
}

const canonicalize = (tx: CML.Transaction) =>
  CML.Transaction.from_cbor_hex(
    CML.Transaction.new(tx.body(), tx.witness_set(), tx.is_valid(), tx.auxiliary_data()).to_canonical_cbor_hex()
  )

const applyScriptDataHash = (tx: CML.Transaction, costModels: CML.CostModels) => {
  const hash = computeScriptDataHash(tx.witness_set(), costModels)
  if (!hash) {
    const witnessJson = (() => {
      try { return JSON.parse(tx.witness_set().to_json()) } catch { return {} }
    })()
    throw new Error(`No script data hash could be computed (redeemers: ${Boolean(tx.witness_set().redeemers())}, witness keys: ${Object.keys(witnessJson).join(",")})`)
  }
  const body = tx.body()
  body.set_script_data_hash(hash)
  return {
    hash,
    tx: canonicalize(CML.Transaction.new(body, tx.witness_set(), tx.is_valid(), tx.auxiliary_data())),
  }
}

const assertHashMatchesWitnesses = (tx: CML.Transaction, costModels: CML.CostModels) => {
  const expected = computeScriptDataHash(tx.witness_set(), costModels)
  const supplied = tx.body().script_data_hash()
  if (!expected || !supplied || expected.to_hex() !== supplied.to_hex()) {
    throw new Error(`Script integrity hash does not match witnesses (supplied ${hashHex(supplied)}, expected ${hashHex(expected)})`)
  }
}

const patchTx = (txCbor: string, costModels: CML.CostModels) => {
  const original = CML.Transaction.from_cbor_hex(txCbor)
  const originalHash = hashHex(original.body().script_data_hash())
  // Hash must be computed from the same CBOR encoding we will submit.
  const { hash, tx } = applyScriptDataHash(canonicalize(original), costModels)
  const out = tx.to_canonical_cbor_hex()
  assertHashMatchesWitnesses(CML.Transaction.from_cbor_hex(out), costModels)
  return { tx: out, originalHash, newHash: hash.to_hex() }
}

const assembleTx = (txCbor: string, witnessesCbor: string, costModels: CML.CostModels) => {
  const tx = CML.Transaction.from_cbor_hex(txCbor)
  const extra = CML.TransactionWitnessSet.from_cbor_hex(witnessesCbor)
  const merged = tx.witness_set()
  merged.add_all_witnesses(extra)
  // Do not canonicalize again: that would rewrite redeemer CBOR and invalidate the signed script hash.
  const assembled = CML.Transaction.new(tx.body(), merged, tx.is_valid(), tx.auxiliary_data())
  const out = assembled.to_cbor_hex()
  assertHashMatchesWitnesses(CML.Transaction.from_cbor_hex(out), costModels)
  return out
}

const conwayScriptHash: NextApiHandler = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }
  const txCbor = typeof req.body?.tx === "string" ? req.body.tx : ""
  const witnessesCbor = typeof req.body?.witnesses === "string" ? req.body.witnesses : ""
  if (!txCbor) {
    return res.status(400).json({ error: "Missing tx" })
  }
  try {
    const projectId = process.env.BLOCKFROST_PROJECT_ID_PREPROD
    if (!projectId) {
      throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set")
    }
    const params = await fetch("https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters", {
      headers: { project_id: projectId },
    }).then((r) => r.json())
    if (params.error) {
      throw new Error(params.message || "Could not fetch protocol parameters")
    }
    const costModels = costModelsFromRaw(params.cost_models_raw || {})
    if (witnessesCbor) {
      return res.status(200).json({ tx: assembleTx(txCbor, witnessesCbor, costModels) })
    }
    const patched = patchTx(txCbor, costModels)
    console.info("conway-script-hash", { originalHash: patched.originalHash, newHash: patched.newHash })
    return res.status(200).json(patched)
  } catch (e) {
    console.error("conway-script-hash", e)
    return res.status(500).json({ error: e instanceof Error ? e.message : "Could not patch script data hash" })
  }
}

export default conwayScriptHash
