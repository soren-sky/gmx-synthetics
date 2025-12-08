import { _TypedDataEncoder } from "ethers/lib/utils";
import { BigNumberish, ethers } from "ethers";
import { GELATO_RELAY_ADDRESS } from "./addresses";

// Nonce error retry configuration
const NONCE_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 3000,
  maxDelayMs: 30000,
};

// Check if error is a nonce-related error
function isNonceError(error: any): boolean {
  const errorMessage = error?.message || error?.error?.message || error?.toString() || "";
  const noncePatterns = [
    /nonce.*too low/i,
    /nonce.*already.*used/i,
    /NONCE_EXPIRED/i,
    /replacement transaction underpriced/i,
    /transaction.*underpriced/i,
    /already known/i,
    /nonce.*mismatch/i,
  ];
  return noncePatterns.some((pattern) => pattern.test(errorMessage));
}

// Wait with exponential backoff
async function waitWithBackoff(attempt: number): Promise<void> {
  const delay = Math.min(NONCE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt), NONCE_RETRY_CONFIG.maxDelayMs);
  console.log(`  Waiting ${delay}ms before retry (attempt ${attempt + 1}/${NONCE_RETRY_CONFIG.maxRetries})...`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export type SubaccountApproval = {
  subaccount: string;
  shouldAdd: boolean;
  expiresAt: BigNumberish;
  maxAllowedCount: BigNumberish;
  actionType: string;
  nonce: BigNumberish;
  integrationId: string;
  deadline: BigNumberish;
  signature: string;
};

export type ExternalCalls = {
  sendTokens: string[];
  sendAmounts: BigNumberish[];
  externalCallTargets: string[];
  externalCallDataList: string[];
  refundTokens: string[];
  refundReceivers: string[];
};

export type TokenPermit = {
  owner: string;
  spender: string;
  value: BigNumberish;
  deadline: BigNumberish;
  v: BigNumberish;
  r: BigNumberish;
  s: BigNumberish;
  token: string;
};

export type OracleParams = {
  tokens: string[];
  providers: string[];
  data: string[];
};

export type FeeParams = {
  feeToken: string;
  feeAmount: BigNumberish;
  feeSwapPath: string[];
};

export type RelayParams = {
  oracleParams: OracleParams;
  tokenPermits: TokenPermit[];
  externalCalls: ExternalCalls;
  fee: FeeParams;
  userNonce: BigNumberish;
  deadline: BigNumberish;
  desChainId: BigNumberish;
};

export type CreateOrderParams = {
  addresses: {
    receiver: string;
    cancellationReceiver: string;
    callbackContract: string;
    uiFeeReceiver: string;
    market: string;
    initialCollateralToken: string;
    swapPath: string[];
  };
  numbers: {
    sizeDeltaUsd: BigNumberish;
    initialCollateralDeltaAmount: BigNumberish;
    triggerPrice: BigNumberish;
    acceptablePrice: BigNumberish;
    executionFee: BigNumberish;
    callbackGasLimit: BigNumberish;
    minOutputAmount: BigNumberish;
    validFromTime: BigNumberish;
  };
  orderType: BigNumberish;
  decreasePositionSwapType: BigNumberish;
  isLong: boolean;
  shouldUnwrapNativeToken: boolean;
  referralCode: string;
  dataList: string[];
};

export type UpdateOrderParams = {
  key: string;
  sizeDeltaUsd: BigNumberish;
  acceptablePrice: BigNumberish;
  triggerPrice: BigNumberish;
  minOutputAmount: BigNumberish;
  validFromTime: BigNumberish;
  autoCancel: boolean;
  executionFeeIncrease: BigNumberish;
};

function getDefaultOracleParams() {
  return {
    tokens: [],
    providers: [],
    data: [],
  };
}

export async function getRelayParams(p: {
  oracleParams?: any;
  tokenPermits?: any;
  externalCalls?: any;
  feeParams: any;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  desChainId: BigNumberish;
  relayRouter: ethers.Contract;
  signer: ethers.Signer;
}) {
  let userNonce = p.userNonce;
  if (userNonce === undefined) {
    userNonce = await getUserNonce();
  }
  return {
    oracleParams: p.oracleParams || getDefaultOracleParams(),
    tokenPermits: p.tokenPermits || [],
    externalCalls: p.externalCalls || {
      sendTokens: [],
      sendAmounts: [],
      externalCallTargets: [],
      externalCallDataList: [],
      refundTokens: [],
      refundReceivers: [],
    },
    fee: p.feeParams,
    userNonce,
    deadline: p.deadline,
    desChainId: p.desChainId,
  };
}

export function getDomain(chainId: BigNumberish, verifyingContract: string) {
  if (!chainId) {
    throw new Error("chainId is required");
  }
  if (!verifyingContract) {
    throw new Error("verifyingContract is required");
  }
  return {
    name: "GmxBaseGelatoRelayRouter",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export function hashRelayParams(relayParams: RelayParams) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(address[] tokens, address[] providers, bytes[] data)",
      "tuple(address[] sendTokens,uint256[] sendAmounts,address[] externalCallTargets, bytes[] externalCallDataList, address[] refundTokens, address[] refundReceivers)",
      "tuple(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s, address token)[]",
      "tuple(address feeToken, uint256 feeAmount, address[] feeSwapPath)",
      "uint256",
      "uint256",
      "uint256",
    ],
    [
      [relayParams.oracleParams.tokens, relayParams.oracleParams.providers, relayParams.oracleParams.data],
      relayParams.externalCalls,
      relayParams.tokenPermits.map((permit) => [
        permit.owner,
        permit.spender,
        permit.value,
        permit.deadline,
        permit.v,
        permit.r,
        permit.s,
        permit.token,
      ]),
      [relayParams.fee.feeToken, relayParams.fee.feeAmount, relayParams.fee.feeSwapPath],
      relayParams.userNonce,
      relayParams.deadline,
      relayParams.desChainId,
    ]
  );

  return ethers.utils.keccak256(encoded);
}

export function hashSubaccountApproval(subaccountApproval: SubaccountApproval) {
  assertFields(subaccountApproval, [
    "subaccount",
    "shouldAdd",
    "expiresAt",
    "maxAllowedCount",
    "actionType",
    "nonce",
    "desChainId",
    "deadline",
    "integrationId",
    "signature",
  ]);

  const hash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId,bytes signature)",
      ],
      [subaccountApproval]
    )
  );
  return hash;
}

export function assertFields(obj: any, fields: string[]) {
  for (const field of fields) {
    if (obj[field] === undefined) {
      throw new Error(`Field ${field} is undefined`);
    }
  }
}

export async function getUserNonce() {
  return Math.floor(Math.random() * 1000000); // Generate a random nonce
}

export async function signTypedData(
  signer: ethers.Signer,
  domain: Record<string, any>,
  types: Record<string, any>,
  typedData: Record<string, any>,
  minified = false
) {
  for (const [key, value] of Object.entries(domain)) {
    if (value === undefined) {
      throw new Error(`signTypedData: domain.${key} is undefined`);
    }
  }
  for (const [key, value] of Object.entries(typedData)) {
    if (value === undefined) {
      throw new Error(`signTypedData: typedData.${key} is undefined`);
    }
  }

  if (!minified) {
    return (signer as any)._signTypedData(domain, types, typedData);
  }

  const digest = _TypedDataEncoder.hash(domain, types, typedData);
  const minifiedTypes = {
    Minified: [{ name: "digest", type: "bytes32" }],
  };
  return (signer as any)._signTypedData(domain, minifiedTypes, {
    digest,
  });
}

export async function sendRelayTransaction({
  calldata,
  gelatoRelayFeeToken,
  gelatoRelayFeeAmount,
  sender,
  relayRouter,
}: {
  calldata: string;
  gelatoRelayFeeToken: string;
  gelatoRelayFeeAmount: BigNumberish;
  sender: ethers.Signer;
  relayRouter: ethers.Contract;
}) {
  let lastError: any;

  for (let attempt = 0; attempt < NONCE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await sender.sendTransaction({
        to: relayRouter.address,
        data: ethers.utils.solidityPack(
          ["bytes", "address", "address", "uint256"],
          [calldata, GELATO_RELAY_ADDRESS, gelatoRelayFeeToken, gelatoRelayFeeAmount]
        ),
        gasLimit: 5000000,
      });
    } catch (ex) {
      lastError = ex;

      if (isNonceError(ex)) {
        console.log(`  Nonce error in sendRelayTransaction: ${ex.message || ex}`);

        if (attempt < NONCE_RETRY_CONFIG.maxRetries - 1) {
          await waitWithBackoff(attempt);
          console.log(`  Retrying sendRelayTransaction...`);
          continue;
        }
      }

      if (ex.error) {
        // this gives much more readable error in the console with a stacktrace
        throw ex.error;
      }
      throw ex;
    }
  }

  throw new Error(`sendRelayTransaction failed after ${NONCE_RETRY_CONFIG.maxRetries} retries: ${lastError}`);
}
