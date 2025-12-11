import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const txHash = "0x83a0287e85e8a657416c6306498aec24420b154a41039fc0089383fc3a75a5bc";

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  console.log("Gas Used:", receipt.gasUsed.toString());

  const eventEmitter = await ethers.getContract("EventEmitter");

  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === eventEmitter.address.toLowerCase()) {
        const parsed = eventEmitter.interface.parseLog(log);
        if (parsed.name === "EventLog2") {
          const eventType = parsed.args[1];
          if (eventType === "DepositCancelled") {
            console.log("\n❌ DEPOSIT CANCELLED");
            const eventData = parsed.args[5];
            if (eventData && eventData[5] && eventData[5][0]) {
              for (const item of eventData[5][0]) {
                if (item[0] === "reasonBytes") {
                  console.log("  reasonBytes:", item[1]);
                }
              }
            }
          } else if (eventType === "DepositExecuted") {
            console.log("\n✅ DEPOSIT EXECUTED SUCCESSFULLY!");
          }
        }
      }
    } catch {
      // skip non-parseable logs
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
