import { TransactionRequest, TransactionResponse } from "ethers";
import { ARBITRUM } from "config/chains";

import { extendError } from "lib/errors";
import { additionalTxnErrorValidation } from "lib/errors/additionalValidation";
import { estimateGasLimit } from "lib/gas/estimateGasLimit";
import { GasPriceData, getGasPrice } from "lib/gas/gasPrice";
import { getProvider } from "lib/rpc";
import { getTenderlyConfig, simulateCallDataWithTenderly } from "lib/tenderly";
import { WalletSigner } from "lib/wallets";

import { TransactionWaiterResult, TxnCallback, TxnEventBuilder } from "./types";

const DEFAULT_ARBITRUM_PARAMS = {
  gasLimit: 1_000_000n,
  gasPrice: 1_000_000_000n, // 1 gwei
  baseGas: 100_000n,
};

export type WalletTxnCtx = {};

export type WalletTxnResult = {
  transactionHash: string;
  wait: () => Promise<TransactionWaiterResult>;
};

export async function sendWalletTransaction({
  chainId,
  signer,
  to,
  callData,
  value,
  gasLimit,
  gasPriceData,
  runSimulation,
  nonce,
  msg,
  callback,
}: {
  chainId: number;
  signer: WalletSigner;
  to: string;
  callData: string;
  value?: bigint | number;
  gasLimit?: bigint | number;
  gasPriceData?: GasPriceData;
  nonce?: number | bigint;
  msg?: string;
  runSimulation?: () => Promise<void>;
  callback?: TxnCallback<WalletTxnCtx>;
}) {
  const from = signer.address;
  const eventBuilder = new TxnEventBuilder<WalletTxnCtx>({});

  try {
    const tenderlyConfig = getTenderlyConfig();

    if (tenderlyConfig) {
      await simulateCallDataWithTenderly({
        chainId,
        tenderlyConfig,
        provider: signer.provider!,
        to,
        data: callData,
        from,
        value: value,
        gasLimit: gasLimit,
        gasPriceData: gasPriceData,
        blockNumber: undefined,
        comment: msg,
      });
      return {
        transactionHash: undefined,
        wait: async () => ({
          transactionHash: undefined,
          blockNumber: undefined,
          status: "success",
        }),
      };
    }

    const gasLimitPromise = gasLimit
      ? Promise.resolve(gasLimit)
      : estimateGasLimit(signer.provider!, {
          to,
          from,
          data: callData,
          value,
        }).catch(() => undefined);

    const provider = getProvider(undefined, chainId);
    const gasPriceDataPromise = gasPriceData
      ? Promise.resolve(gasPriceData)
      : getGasPrice(provider, chainId).catch(() => undefined);

    const [gasLimitResult, gasPriceDataResult] = await Promise.all([
      gasLimitPromise,
      gasPriceDataPromise,
      runSimulation?.().then(() => callback?.(eventBuilder.Simulated())),
    ]);

    const finalGasLimit = gasLimitResult ?? (chainId === ARBITRUM ? DEFAULT_ARBITRUM_PARAMS.gasLimit : undefined);

    const finalGasPriceData =
      gasPriceDataResult ?? (chainId === ARBITRUM ? { gasPrice: DEFAULT_ARBITRUM_PARAMS.gasPrice } : undefined);

    callback?.(eventBuilder.Sending());

    const txnData: TransactionRequest & { gas?: bigint; baseGas?: bigint } = {
      to,
      data: callData,
      value,
      from,
      nonce: nonce !== undefined ? Number(nonce) : undefined,
      gasLimit: finalGasLimit,
      gas: finalGasLimit,
      baseGas: chainId === ARBITRUM ? DEFAULT_ARBITRUM_PARAMS.baseGas : undefined,
      ...(finalGasPriceData ?? {}),
    };

    const res = await signer.sendTransaction(txnData as TransactionRequest).catch((error) => {
      additionalTxnErrorValidation(error, chainId, signer.provider!, txnData);

      throw extendError(error, {
        errorContext: "sending",
      });
    });

    callback?.(
      eventBuilder.Sent({
        type: "wallet",
        transactionHash: res.hash,
      })
    );

    return {
      transactionHash: res.hash,
      wait: makeWalletTxnResultWaiter(res.hash, res),
    };
  } catch (error) {
    callback?.(eventBuilder.Error(error));

    throw error;
  }
}

function makeWalletTxnResultWaiter(hash: string, txn: TransactionResponse) {
  return async () => {
    const receipt = await txn.wait();
    return {
      transactionHash: hash,
      blockNumber: receipt?.blockNumber,
      status: receipt?.status === 1 ? "success" : "failed",
    };
  };
}
