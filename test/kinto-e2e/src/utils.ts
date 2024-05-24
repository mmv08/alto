import { defineChain, type Hash } from "viem"

export const prettyPrintTxHash = (hash: Hash) => {
    return `https://kintoscan.io/tx/${hash}`
}

export const kintoMainnet = defineChain({
    id: 7887,
    name: "Kinto Mainnet",
    nativeCurrency: {
        name: "ETH",
        symbol: "ETH",
        decimals: 18
    },
    rpcUrls: {
        default: {
            http: [],
            webSocket: undefined
        }
    }
})

export const KINTO_ENTRYPOINT = "0x2843C269D2a64eCfA63548E8B3Fc0FD23B7F70cb"
export const KINTO_RPC =
    "https://7887.rpc.thirdweb.com/9fc39d5e2a3e149cc31cf9625806a2fe"

export const sleep = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
