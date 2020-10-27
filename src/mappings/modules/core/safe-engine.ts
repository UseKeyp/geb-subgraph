import { Address, log, Bytes, ethereum } from '@graphprotocol/graph-ts'

import {
  CollateralType,
  Safe,
  ModifySAFECollateralization as ModifySAFECollateralizationEntity,
} from '../../../../generated/schema'

import { getSystemState } from '../../../entities'

import {
  InitializeCollateralType,
  ModifyParameters as ModifyParametersUint,
  ModifyParameters1 as ModifyParametersCollateralTypeUint,
  ModifyCollateralBalance,
  TransferCollateral,
  TransferInternalCoins,
  TransferSAFECollateralAndDebt,
  ConfiscateSAFECollateralAndDebt,
  SettleDebt,
  CreateUnbackedDebt,
  UpdateAccumulatedRate,
  ModifySAFECollateralization,
} from '../../../../generated/SAFEEngine/SAFEEngine'

import * as decimal from '../../../utils/decimal'
import * as integer from '../../../utils/integer'
import { getOrCreateCollateral } from '../../../entities/collateral'
import {
  updateCoinBalance,
  updateCollateralBalance,
  updateDebtBalance,
  getOrCreateCoinBalance,
  getOrCreateDebtBalance,
  getOrCreateCollateralBalance,
} from '../../../entities/balances'
import { createUnmanagedSafe, updateSafeCollateralization } from '../../../entities/safe'
import { eventUid } from '../../../utils/ethereum'
import { periodicHandler } from './periodic-handler'
import { addresses } from '../../../utils/addresses'

// Register a new collateral type
export function handleInitializeCollateralType(event: InitializeCollateralType): void {
  let collateral = getOrCreateCollateral(event.params.collateralType, event)

  log.info('Onboard new collateral {}', [collateral.id])

  // Update system state
  let system = getSystemState(event)
  system.collateralCount = system.collateralCount.plus(integer.ONE)
  system.save()
}

// Modify collateral type parameters
export function handleModifyParametersUint(event: ModifyParametersUint): void {
  let system = getSystemState(event)
  let what = event.params.parameter.toString()
  let data = event.params.data

  if (what == 'globalDebtCeiling') {
    system.globalDebtCeiling = decimal.fromRad(data)
    system.save()
  }
}

export function handleModifyParametersCollateralTypeUint(
  event: ModifyParametersCollateralTypeUint,
): void {
  let collateralType = event.params.collateralType.toString()
  let what = event.params.parameter.toString()
  let data = event.params.data

  let collateral = CollateralType.load(collateralType)

  if (collateral != null) {
    if (what == 'safetyPrice') {
      // Safety  price is stored on the current price object
    } else if (what == 'debtCeiling') {
      collateral.debtCeiling = decimal.fromRad(data)
    } else if (what == 'debtFloor') {
      collateral.debtFloor = decimal.fromRad(data)
    } else if (what == 'liquidationPrice') {
      // Liquidation price is stored on the current price object
    } else {
      return
    }
    collateral.save()
  }
}
// Modify a user's collateral balance (Called by authorized collateral adapters, mint system coins)
export function handleModifyCollateralBalance(event: ModifyCollateralBalance): void {
  let account = event.params.account
  let collateral = event.params.collateralType
  let amount = decimal.fromWad(event.params.wad)

  // Update user balance
  let balance = getOrCreateCollateralBalance(account, collateral, event)
  updateCollateralBalance(balance, collateral, event)
  balance.save()

  // Update collateral counter
  let collateralObj = getOrCreateCollateral(collateral, event)
  collateralObj.totalCollateral = collateralObj.totalCollateral.plus(amount)
  collateralObj.save()
}

// Transfer collateral between users
export function handleTransferCollateral(event: TransferCollateral): void {
  let collateral = event.params.collateralType
  let src = getOrCreateCollateralBalance(event.params.src, collateral, event, false)
  let dst = getOrCreateCollateralBalance(event.params.dst, collateral, event)
  updateCollateralBalance(src, collateral, event)
  updateCollateralBalance(dst, collateral, event)
  src.save()
  dst.save()
}

// Transfer reflexer coin between users
export function handleTransferInternalCoins(event: TransferInternalCoins): void {
  let src = getOrCreateCoinBalance(event.params.src, event, false)
  let dst = getOrCreateCoinBalance(event.params.dst, event)
  updateCoinBalance(src, event)
  updateCoinBalance(dst, event)
  src.save()
  dst.save()
}

// Create or modify a SAFE
export function handleModifySAFECollateralization(event: ModifySAFECollateralization): void {
  let collateralType = event.params.collateralType.toString()
  let safeAddress = event.params.safe
  let deltaCollateral = decimal.fromWad(event.params.deltaCollateral)
  let deltaDebt = decimal.fromWad(event.params.deltaDebt)

  let collateralBalance = deltaCollateral
  let safeId = safeAddress.toHexString() + '-' + collateralType
  let safe = Safe.load(safeId)

  if (safe == null) {
    // It means that the SafeManager was not used, otherwise they would be a Safe entity already created.
    log.info('New unmanaged: {}', [safeId])
    // Register new unmanaged safe
    safe = createUnmanagedSafe(safeAddress, event.params.collateralType, event)
    updateSafeCollateralization(safe as Safe, collateralBalance, deltaDebt, event)
  } else {
    // Update existing Vault
    log.info('Update cpd collateralization of: ', [safe.id])
    updateSafeCollateralization(
      safe as Safe,
      safe.collateral.plus(collateralBalance),
      safe.debt.plus(deltaDebt),
      event,
    )
  }
  safe.save()

  // Update debt and collateral counters
  let collateral = getOrCreateCollateral(event.params.collateralType, event)
  collateral.debtAmount = collateral.debtAmount.plus(deltaDebt)
  collateral.totalCollateralLockedInSafes = collateral.totalCollateralLockedInSafes.plus(
    deltaCollateral,
  )
  collateral.save()

  let system = getSystemState(event)
  system.globalDebt = system.globalDebt.plus(deltaDebt)
  system.save()

  // Update balances
  let internalCollateralBalance = getOrCreateCollateralBalance(
    event.params.collateralSource,
    event.params.collateralType,
    event,
    false,
  )
  updateCollateralBalance(internalCollateralBalance, event.params.collateralType, event)
  internalCollateralBalance.save()

  let internalCoinBalance = getOrCreateCoinBalance(event.params.debtDestination, event)
  updateCoinBalance(internalCoinBalance, event)
  internalCoinBalance.save()

  // Create a new modify collateralization update
  let update = new ModifySAFECollateralizationEntity(eventUid(event))
  update.safe = safe.id
  update.safeHandler = safeAddress
  update.collateralType = collateral.id
  update.deltaCollateral = deltaCollateral
  update.deltaDebt = deltaDebt
  update.createdAt = event.block.timestamp
  update.createdAtBlock = event.block.number
  update.createdAtTransaction = event.transaction.hash
  update.save()
}

// Split a SAFE - binary approval or splitting/merging Vaults
export function handleTransferSAFECollateralAndDebt(event: TransferSAFECollateralAndDebt): void {
  // Both should be non dusty so they exist
  let srcSafe = Safe.load(
    event.params.src.toHexString() + '-' + event.params.collateralType.toString(),
  ) as Safe
  let dstSafe = Safe.load(
    event.params.src.toHexString() + '-' + event.params.collateralType.toString(),
  ) as Safe

  updateSafeCollateralization(
    srcSafe,
    srcSafe.collateral.minus(decimal.fromWad(event.params.deltaCollateral)),
    srcSafe.debt.minus(decimal.fromWad(event.params.deltaDebt)),
    event,
  )

  updateSafeCollateralization(
    dstSafe,
    dstSafe.collateral.plus(decimal.fromWad(event.params.deltaCollateral)),
    dstSafe.debt.plus(decimal.fromWad(event.params.deltaDebt)),
    event,
  )

  srcSafe.save()
  dstSafe.save()
}

// Liquidate a SAFE
export function handleConfiscateSAFECollateralAndDebt(
  event: ConfiscateSAFECollateralAndDebt,
): void {
  let collateralType = event.params.collateralType
  let deltaDebt = decimal.fromWad(event.params.deltaDebt)
  let deltaCollateral = decimal.fromWad(event.params.deltaCollateral)

  let safe = Safe.load(event.params.safe.toHexString() + '-' + collateralType.toString())
  updateSafeCollateralization(
    safe as Safe,
    safe.collateral.plus(deltaCollateral),
    safe.debt.plus(deltaDebt),
    event,
  )
  safe.save()

  // Update collateral debt counter
  let collateral = getOrCreateCollateral(collateralType, event)
  collateral.debtAmount = collateral.debtAmount.plus(deltaDebt)
  collateral.totalCollateralLockedInSafes = collateral.totalCollateralLockedInSafes.plus(
    deltaCollateral,
  )
  collateral.save()

  // Update counter party collateral
  let collateraCounterPartyBalance = getOrCreateCollateralBalance(
    event.params.collateralCounterparty,
    collateralType,
    event,
  )

  updateCollateralBalance(collateraCounterPartyBalance, collateralType, event)
  collateraCounterPartyBalance.save()

  // Update counter party debt
  let deltaTotalIssuedDebt = deltaDebt.times(collateral.accumulatedRate)
  let debtCounterPartyBalance = getOrCreateDebtBalance(event.params.debtCounterparty, event)
  updateDebtBalance(
    debtCounterPartyBalance,
    debtCounterPartyBalance.balance.minus(deltaTotalIssuedDebt),
    event,
  )
  debtCounterPartyBalance.save()

  // Update global debt counter
  let system = getSystemState(event)
  system.globalUnbackedDebt = system.globalUnbackedDebt.minus(deltaTotalIssuedDebt)
  system.save()
}

// Create/destroy equal quantities of reflexer coin and system debt
export function handleSettleDebt(event: SettleDebt): void {
  let rad = decimal.fromRad(event.params.rad)

  // TODO: This address is missing from the event. Currently only the accounting engine is supposed to do this.
  // Replace with the event param when it's there
  let account = addresses.get('GEB_ACCOUNTING_ENGINE')

  // Update debt counters
  let system = getSystemState(event)
  system.globalDebt = system.globalDebt.minus(rad)
  system.globalUnbackedDebt = system.globalUnbackedDebt.minus(rad)
  system.save()

  // Update debt and coin balance
  let balance = getOrCreateCoinBalance(account, event)
  let debt = getOrCreateDebtBalance(account, event)
  updateCoinBalance(balance, event)
  updateDebtBalance(debt, debt.balance.minus(rad), event)
  balance.save()
  debt.save()
}

// Mint unbacked reflexer coins
export function handleCreateUnbackedDebt(event: CreateUnbackedDebt): void {
  let rad = decimal.fromRad(event.params.rad)

  // Update debt counters
  let system = getSystemState(event)
  system.globalDebt = system.globalDebt.plus(rad)
  system.globalUnbackedDebt = system.globalUnbackedDebt.plus(rad)
  system.save()

  // Credit the coins
  let balance = getOrCreateCoinBalance(event.params.coinDestination, event)
  updateCoinBalance(balance, event)
  balance.save()

  // Add the debt
  let debt = getOrCreateDebtBalance(event.params.debtDestination, event)
  updateDebtBalance(debt, debt.balance.plus(rad), event)
  debt.save()
}

// Modify the debt multiplier, creating/destroying corresponding debt
export function handleUpdateAccumulatedRate(event: UpdateAccumulatedRate): void {
  let rate = decimal.fromRay(event.params.rateMultiplier)
  let collateral = getOrCreateCollateral(event.params.collateralType, event)
  let rad = collateral.debtAmount.times(rate)

  // Set the new rate
  collateral.accumulatedRate = collateral.accumulatedRate.plus(rate)
  collateral.save()

  // Update debt counter
  let system = getSystemState(event)
  system.globalDebt = decimal.fromRad(event.params.globalDebt)
  system.save()

  // Send the taxes
  let dst = getOrCreateCoinBalance(event.params.surplusDst, event)
  updateCoinBalance(dst, event)
  dst.save()

  periodicHandler(event)
}
