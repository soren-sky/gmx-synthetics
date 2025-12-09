import hre from "hardhat";

const { ethers } = hre as any;

async function getDeployment(contractName: string) {
  try {
    return await ethers.getContract(contractName);
  } catch (error: any) {
    if (error?.message?.includes("No Contract deployed with name")) {
      return null;
    }
    throw error;
  }
}

async function main() {
  console.log("\n  Deployed Markets");
  console.log("  ────────────────────────────────────────────────────────────────────────");

  const reader = await getDeployment("Reader");
  const dataStore = await getDeployment("DataStore");

  if (!reader || !dataStore) {
    console.log("  Reader or DataStore not deployed yet.");
    console.log("  Run: make deploy-core");
    return;
  }

  try {
    const markets = await reader.getMarkets(dataStore.address, 0, 100);

    if (markets.length === 0) {
      console.log("  No markets deployed yet.");
      console.log("  Run: make create-market");
      return;
    }

    console.log(`  Found ${markets.length} market(s):\n`);

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      console.log(`  [${i + 1}] Market Token: ${market.marketToken}`);
      console.log(`      Index Token:  ${market.indexToken}`);
      console.log(`      Long Token:   ${market.longToken}`);
      console.log(`      Short Token:  ${market.shortToken}`);
      console.log("");
    }
  } catch (e: any) {
    console.log(`  Error reading markets: ${e.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
