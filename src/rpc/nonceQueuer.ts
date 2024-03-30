import {
    EntryPointV06Abi,
    type MempoolUserOperation,
    deriveUserOperation
} from "@alto/types"
import type { Logger } from "@alto/utils"
import {
    getNonceKeyAndValue,
    getUserOperationHash,
    isVersion06
} from "@alto/utils"
import {
    type Address,
    type Chain,
    type Hash,
    type MulticallReturnType,
    type PublicClient,
    type Transport,
    getContract
} from "viem"
import type { MemoryMempool } from "@alto/mempool"

type QueuedUserOperation = {
    entryPoint: Address
    userOperationHash: Hash
    mempoolUserOperation: MempoolUserOperation
    nonceKey: bigint
    nonceValue: bigint
    addedAt: number
}

export class NonceQueuer {
    queuedUserOperations: QueuedUserOperation[] = []

    mempool: MemoryMempool
    publicClient: PublicClient<Transport, Chain>
    logger: Logger

    constructor(
        mempool: MemoryMempool,
        publicClient: PublicClient<Transport, Chain>,
        logger: Logger
    ) {
        this.mempool = mempool
        this.publicClient = publicClient
        this.logger = logger

        setInterval(() => {
            this.process()
        }, 2000)
    }

    async process() {
        // remove queued ops that have been in the queue for more than 15 minutes
        this.queuedUserOperations = this.queuedUserOperations.filter((qop) => {
            return qop.addedAt > Date.now() - 1000 * 60 * 15
        })

        if (this.queuedUserOperations.length === 0) {
            return
        }

        const availableOps = await this.getAvailableUserOperations(
            this.publicClient
        )

        if (availableOps.length === 0) {
            return
        }

        this.queuedUserOperations = this.queuedUserOperations.filter((qop) => {
            return !availableOps.some((op) => {
                return op.userOperationHash === qop.userOperationHash
            })
        })

        availableOps.map((op) => {
            this.resubmitUserOperation(op.mempoolUserOperation, op.entryPoint)
        })

        this.logger.info(
            { availableOps: availableOps.map((qop) => qop.userOperationHash) },
            "submitted user operations from nonce queue"
        )
    }

    add(mempoolUserOperation: MempoolUserOperation, entryPoint: Address) {
        const userOp = deriveUserOperation(mempoolUserOperation)
        const [nonceKey, nonceValue] = getNonceKeyAndValue(userOp.nonce)
        this.queuedUserOperations.push({
            entryPoint,
            userOperationHash: getUserOperationHash(
                deriveUserOperation(mempoolUserOperation),
                entryPoint,
                this.publicClient.chain.id
            ),
            mempoolUserOperation: mempoolUserOperation,
            nonceKey: nonceKey,
            nonceValue: nonceValue,
            addedAt: Date.now()
        })
    }

    resubmitUserOperation(
        mempoolUserOperation: MempoolUserOperation,
        entryPoint: Address
    ) {
        const userOperation = mempoolUserOperation
        this.logger.info(
            { userOperation: userOperation },
            "submitting user operation from nonce queue"
        )
        const result = this.mempool.add(mempoolUserOperation, entryPoint)
        if (result) {
            this.logger.info(
                { userOperation: userOperation, result: result },
                "added user operation"
            )
        } else {
            this.logger.error("error adding user operation")
        }
    }

    async getAvailableUserOperations(publicClient: PublicClient) {
        const queuedUserOperations = this.queuedUserOperations.slice()

        let results: MulticallReturnType

        try {
            results = await publicClient.multicall({
                contracts: queuedUserOperations.map((qop) => {
                    const userOp = deriveUserOperation(qop.mempoolUserOperation)
                    return {
                        address: qop.entryPoint,
                        abi: EntryPointV06Abi,
                        functionName: "getNonce",
                        args: [userOp.sender, qop.nonceKey]
                    }
                }),
                blockTag: "latest"
            })
        } catch (error) {
            this.logger.error(
                { error: JSON.stringify(error) },
                "error fetching with multiCall"
            )

            results = await Promise.all(
                queuedUserOperations.map(async (qop) => {
                    const userOp = deriveUserOperation(qop.mempoolUserOperation)
                    try {
                        const isUserOpV06 = isVersion06(userOp)

                        const entryPointContract = isUserOpV06
                            ? getContract({
                                  abi: EntryPointV06Abi,
                                  address: qop.entryPoint,
                                  client: {
                                      public: publicClient
                                  }
                              })
                            : getContract({
                                  abi: EntryPointV06Abi,
                                  address: qop.entryPoint,
                                  client: {
                                      public: publicClient
                                  }
                              })

                        const nonce = await entryPointContract.read.getNonce(
                            [userOp.sender, qop.nonceKey],
                            { blockTag: "latest" }
                        )
                        return {
                            result: nonce,
                            status: "success"
                        }
                    } catch (e) {
                        return {
                            error: e as Error,
                            status: "failure"
                        }
                    }
                })
            )
        }

        if (results.length !== queuedUserOperations.length) {
            this.logger.error("error fetching nonces")
            return []
        }

        const currentOutstandingOps: QueuedUserOperation[] = []

        for (let i = 0; i < queuedUserOperations.length; i++) {
            const qop = queuedUserOperations[i]
            const result = results[i]

            if (result.status !== "success") {
                this.logger.error(
                    { error: result.error },
                    "error fetching nonce"
                )
                continue
            }

            const onchainNonceValue = result.result

            if (onchainNonceValue === qop.nonceValue) {
                currentOutstandingOps.push(qop)
            }
        }

        return currentOutstandingOps
    }
}
