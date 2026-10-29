import { SEAT_ERROR } from "@noirwire/orderbook";
import type { SweepStop } from "./chain-types.js";

/** `SlotsFull`: a seat holds positions or orders on four markets and an order needs a fifth. */
export const SLOTS_FULL_ERROR = SEAT_ERROR.slotsFull;

/** `NotSeated`: the view holds no seat. A first collateral deposit takes one. */
export const NOT_SEATED_ERROR = SEAT_ERROR.notSeated;

/** `SeatDepositTooSmall`: a deposit that would take a seat was spot, or below the exchange's minimum. */
export const SEAT_DEPOSIT_TOO_SMALL_ERROR = SEAT_ERROR.seatDepositTooSmall;

const OWNER_TRANSACTION_ERROR = {
  invalidProof: 6151,
  wrongNonce: 6152,
  expiryTooFar: 6153,
  wrongWithdrawDestination: 6154,
} as const;

/**
 * The order book program's error names by the number a failed transaction
 * reports (its code plus 6000). The program never reuses or renumbers a
 * code, so a number keeps its name across releases.
 */
const PROGRAM_ERROR_NAMES: Record<number, string> = {
  6001: "MathOverflow",
  6002: "InvariantBroken",
  6003: "InvalidMarketParams",
  6004: "MarketMismatch",
  6005: "JournalFull",
  6006: "StepLimitTooLarge",
  6010: "SeatOutOfRange",
  6011: "SeatNotOpen",
  6012: "NotSeatOwner",
  6013: "SeatTableFull",
  6014: "SeatAlreadyOpen",
  6015: "SeatNotEmpty",
  6016: "ReservedSeat",
  6017: "NotReservedSeat",
  6020: "InvalidToken",
  6021: "ZeroAmount",
  6022: "InsufficientBalance",
  6023: "InsufficientCollateral",
  6024: "InsufficientMargin",
  6025: "BalanceCapExceeded",
  6030: "ExchangePaused",
  6031: "MarketPaused",
  6032: "MarketReduceOnly",
  6033: "InvalidOrderFlags",
  6034: "SizeTooSmall",
  6035: "PriceOffTick",
  6036: "NotionalTooSmall",
  6037: "PriceOutsideBand",
  6038: "StalePrice",
  6039: "PriceUnavailable",
  6040: "TooManyOpenOrders",
  6043: "ReduceOnlyWouldIncrease",
  6044: "MarketDataMissing",
  6045: "FeeSeatNotOpen",
  6046: "OrderExpired",
  6047: "InsuranceSeatNotOpen",
  6048: "PositionCapExceeded",
  6050: "OrderNotFound",
  6060: "NotPerpMarket",
  6061: "NotLiquidatable",
  6062: "SelfLiquidation",
  6063: "NoPosition",
  6064: "ShortfallOutstanding",
  6070: "PriceTimeWentBackwards",
  6071: "PriceMoveTooLarge",
  6072: "ZeroPrice",
  6073: "PricePublishedTooSoon",
  6074: "PriceFromTheFuture",
  6075: "PriceTooHigh",
  6076: "FeedNotSeeded",
  6077: "OracleDislocated",
  6078: "OracleIncident",
  6079: "PriceTooOld",
  6080: "PriceConfidenceTooWide",
  6081: "QuoteGuardTripped",
  6090: "SeatBlocked",
  6091: "MakerNotListed",
  6092: "TakerNotListed",
  [SLOTS_FULL_ERROR]: "SlotsFull",
  6100: "NotUpgradeAuthority",
  6101: "NotAdmin",
  6102: "NotNominee",
  6103: "GateMissing",
  6104: "NotOracle",
  6105: "InvalidSettings",
  6106: "BelowRent",
  6107: "UnknownToken",
  6108: "WrongCustody",
  6109: "WrongMint",
  6110: "WrongTokenAccountOwner",
  6111: "WrongTokenProgram",
  6112: "TokenAccountUninitialised",
  6113: "AccountExists",
  6114: "AccountMissing",
  6115: "WrongOwner",
  6116: "WrongDerivation",
  6117: "WrongKind",
  6118: "WrongSize",
  6119: "NotReady",
  6120: "AlreadyReady",
  6121: "WrongMarket",
  6122: "InvalidGrowth",
  6123: "NotOrderKey",
  6124: "InvalidOrderKey",
  6125: "NotViewOwner",
  6126: "MarketExists",
  6127: "InvalidCapacity",
  6128: "MalformedRemainingAccounts",
  6129: "DuplicateMarket",
  6130: "CounterOverflow",
  6131: "Unaligned",
  6132: "InvalidSchedule",
  6133: "Expired",
  6134: "ExpiryTooFar",
  6135: "ResumeOnly",
  6136: "CustodyNotPrivate",
  6137: "DailySeatLimitReached",
  6138: "SeatUsed",
  6139: "CustodyNotPublic",
  6140: "PayoutIntoCustody",
  6141: "WrongPriceAccount",
  6142: "WrongPriceAccountOwner",
  6143: "WrongPriceAccountSize",
  6144: "WrongPriceAccountKind",
  6145: "PriceNotFullyVerified",
  6146: "WrongPriceFeed",
  6147: "WrongPriceExponent",
  6148: "PriceSourceBound",
  6149: "PriceSourceInUse",
  6150: "CustodyCapReached",
  [NOT_SEATED_ERROR]: "NotSeated",
  [SEAT_DEPOSIT_TOO_SMALL_ERROR]: "SeatDepositTooSmall",
  [SEAT_ERROR.layoutNotMigrated]: "LayoutNotMigrated",
  [SEAT_ERROR.alreadyMigrated]: "AlreadyMigrated",
  [SEAT_ERROR.ledgerTooLarge]: "LedgerTooLarge",
  [SEAT_ERROR.relayoutOutOfOrder]: "RelayoutOutOfOrder",
  [SEAT_ERROR.relayoutMismatch]: "RelayoutMismatch",
  [SEAT_ERROR.relayoutIncomplete]: "RelayoutIncomplete",
  [OWNER_TRANSACTION_ERROR.invalidProof]: "InvalidOwnerProof",
  [OWNER_TRANSACTION_ERROR.wrongNonce]: "WrongOwnerNonce",
  [OWNER_TRANSACTION_ERROR.expiryTooFar]: "OwnerExpiryTooFar",
  [OWNER_TRANSACTION_ERROR.wrongWithdrawDestination]: "WrongWithdrawDestination",
};

/** `Expired`: a signed action or order reached the program after its expiry. */
export const EXPIRED_ERROR = 6133;

/** What the program refused an owner's signed action for, in words for the person, with the HTTP status that fits. */
export const ownerRefusalOf = (
  code: number | null,
): { status: 400 | 409 | 410; reason: string } | null => {
  switch (code) {
    case OWNER_TRANSACTION_ERROR.invalidProof:
      return {
        status: 400,
        reason:
          "the rollup did not accept the wallet's signature for this account opening. Nothing changed: sign again",
      };
    case OWNER_TRANSACTION_ERROR.wrongNonce:
      return {
        status: 409,
        reason: "the account changed since this was signed. Nothing changed: reload and try again",
      };
    case OWNER_TRANSACTION_ERROR.expiryTooFar:
      return {
        status: 400,
        reason: "the signed message expires too far ahead. Nothing changed: prepare again",
      };
    case OWNER_TRANSACTION_ERROR.wrongWithdrawDestination:
      return {
        status: 400,
        reason: "the withdrawal must go to the owner's own token account. Nothing changed",
      };
    case EXPIRED_ERROR:
      return {
        status: 410,
        reason:
          "the signed message expired before it was sent. Nothing changed: prepare again and sign again",
      };
    default:
      return null;
  }
};

/**
 * `MakerNotListed`: on a market whose maker list is on, a resting order from
 * a seat not on it. The exchange admin lists a seat, by its owner key, with
 * `set_seat_access`.
 */
export const MAKER_NOT_LISTED_ERROR = 6091;

/** `OrderNotFound`: a cancel named an order the book no longer holds for that seat. */
export const ORDER_NOT_FOUND_ERROR = 6050;

/** `SeatAlreadyOpen`: the owner key already holds a trader seat. */
export const SEAT_ALREADY_OPEN_ERROR = 6014;

/** `AccountExists`: the account the transaction creates is there already. */
export const ACCOUNT_EXISTS_ERROR = 6113;

/** `SeatTableFull`: the exchange has no free seat to give. */
export const SEAT_TABLE_FULL_ERROR = 6013;

/** `ExchangePaused`: the exchange takes no new actions while paused. */
export const EXCHANGE_PAUSED_ERROR = 6030;

/** `GateMissing`: the exchange has no gate listed, or not this one. */
export const GATE_MISSING_ERROR = 6103;

/** `BelowRent`: a payment is below the rent the account it creates needs. */
export const BELOW_RENT_ERROR = 6106;
const SEAT_REFUSAL_TEXT: Record<number, string> = {
  [SLOTS_FULL_ERROR]:
    "this account already holds positions or orders on four markets, and a fifth needs a free slot. Nothing changed: close a position or cancel the orders on one market first",
  [NOT_SEATED_ERROR]:
    "this account holds no seat right now. Nothing changed: deposit collateral to take one",
  [SEAT_DEPOSIT_TOO_SMALL_ERROR]:
    "the first deposit of an account must be collateral and at least what the exchange asks for a seat. Nothing changed",
  [SEAT_ERROR.relayoutOutOfOrder]:
    "the exchange is moving to a new seat ledger and cannot take this step right now. Nothing changed",
  [SEAT_ERROR.relayoutMismatch]:
    "the exchange's move to a new seat ledger found a seat it could not copy. Nothing changed: tell the operator",
  [SEAT_ERROR.relayoutIncomplete]:
    "the exchange's move to a new seat ledger is not finished yet. Nothing changed: try again later",
};

/** What the program refused for, in words for the person, when it is one of the seat refusals; else null. */
export const programRefusalText = (code: number): string | null => SEAT_REFUSAL_TEXT[code] ?? null;

/** Why a range liquidation ended before its last seat, in words for the operator. */
export const sweepStopText = (stop: SweepStop): string => {
  switch (stop) {
    case "stalePrice":
      return "the market's price is stale, so the sweep waits for a fresh one";
    case "liquidatorMarginInsufficient":
      return "the liquidator's collateral cannot carry another takeover: fund its seat";
    case "liquidatorSlotsFull":
      return "the liquidator's seat already holds positions or orders on four other markets and cannot take over a fifth: the sweep skips that seat";
    case "unrecognised":
      return "the program ended the sweep for a reason this release does not know";
  }
};

/** The program's name for error number `code`, or a plain description when it has none here. */
export const programErrorName = (code: number): string =>
  PROGRAM_ERROR_NAMES[code] ?? "unnamed program error";

/** `Name (number)`, as a log line names a program error. */
export const programErrorLabel = (code: number): string => `${programErrorName(code)} (${code})`;
