import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const txHash = "0xab30f6dbb14f00f4c5911f2506ecb9516222e1379508dc6938391943cfed7edc";

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  const eventEmitter = await ethers.getContract("EventEmitter");

  console.log("Oracle prices used in transaction:\n");

  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === eventEmitter.address.toLowerCase()) {
        const parsed = eventEmitter.interface.parseLog(log);
        if (parsed.name === "EventLog1" && parsed.args[1] === "OraclePriceUpdate") {
          const eventData = parsed.args[4];

          // Extract token and prices
          let token = "";
          let minPrice = "";

          if (eventData[0] && eventData[0][0]) {
            for (const item of eventData[0][0]) {
              if (item[0] === "token") token = item[1];
            }
          }
          if (eventData[1] && eventData[1][0]) {
            for (const item of eventData[1][0]) {
              if (item[0] === "minPrice") minPrice = item[1].toString();
            }
          }

          console.log("Token:", token);
          console.log("  Price:", minPrice);
          console.log("  Scientific:", parseFloat(minPrice).toExponential());
          console.log();
        }
      }
    } catch (e) {
      // skip
    }
  }

  // What the correct prices should be
  console.log("\n=== Expected prices for 18-decimal tokens ===");
  console.log("BTCB ($100k): 10^17 =", ethers.BigNumber.from(10).pow(17).toString());
  console.log("USDC ($1):    10^12 =", ethers.BigNumber.from(10).pow(12).toString());
  console.log("WBNB ($600): 6*10^14 =", ethers.BigNumber.from(6).mul(ethers.BigNumber.from(10).pow(14)).toString());
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
