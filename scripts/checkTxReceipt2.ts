import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const txHash = "0xab30f6dbb14f00f4c5911f2506ecb9516222e1379508dc6938391943cfed7edc";

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  console.log("Transaction Receipt:");
  console.log("  Status:", receipt.status);
  console.log("  Block:", receipt.blockNumber);
  console.log("  Gas Used:", receipt.gasUsed.toString());
  console.log("  Logs count:", receipt.logs.length);

  const eventEmitter = await ethers.getContract("EventEmitter");

  // Look for DepositCancelled or DepositExecuted
  let depositResult = "Unknown";
  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === eventEmitter.address.toLowerCase()) {
        const parsed = eventEmitter.interface.parseLog(log);
        if (parsed.name === "EventLog2") {
          const eventType = parsed.args[1];
          if (eventType === "DepositCancelled") {
            depositResult = "CANCELLED";
            console.log("\n*** DEPOSIT CANCELLED ***");
            // Extract reasonBytes
            const eventData = parsed.args[5];
            if (eventData && eventData[5] && eventData[5][0]) {
              for (const item of eventData[5][0]) {
                if (item[0] === "reasonBytes") {
                  console.log("  reasonBytes:", item[1]);
                }
              }
            }
          } else if (eventType === "DepositExecuted") {
            depositResult = "EXECUTED";
            console.log("\n*** DEPOSIT EXECUTED SUCCESSFULLY! ***");
          }
        }
      }
    } catch (e) {
      // skip
    }
  }

  console.log("\nDeposit result:", depositResult);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
