import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const txHash = "0x1ea88cfcc997c9fd9011c07127ea5432c919c9258bea1ede680614a24a74341e";

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  console.log("Transaction Receipt:");
  console.log("  Status:", receipt.status);
  console.log("  Block:", receipt.blockNumber);
  console.log("  Gas Used:", receipt.gasUsed.toString());
  console.log("  Logs count:", receipt.logs.length);

  // Decode events
  const eventEmitter = await ethers.getContract("EventEmitter");

  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === eventEmitter.address.toLowerCase()) {
        const parsed = eventEmitter.interface.parseLog(log);
        console.log("\nEvent:", parsed.name);
        console.log("  Args:", JSON.stringify(parsed.args, null, 2));
      }
    } catch (e) {
      // skip unparseable logs
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
