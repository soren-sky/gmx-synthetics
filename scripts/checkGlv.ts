import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const glvReader = await ethers.getContract("GlvReader");
  const dataStore = await ethers.getContract("DataStore");

  console.log("GlvReader:", glvReader.address);
  console.log("DataStore:", dataStore.address);

  const glvs = await glvReader.getGlvs(dataStore.address, 0, 10);
  console.log("\nGLVs found:", glvs.length);

  for (let i = 0; i < glvs.length; i++) {
    const glv = glvs[i];
    console.log(`\nGLV ${i}:`);
    console.log("  glvToken:", glv.glvToken);
    console.log("  longToken:", glv.longToken);
    console.log("  shortToken:", glv.shortToken);

    // Get GLV info with markets
    const glvInfo = await glvReader.getGlvInfo(dataStore.address, glv.glvToken);
    console.log("  markets:", glvInfo.markets?.length || 0);
    if (glvInfo.markets) {
      for (const m of glvInfo.markets) {
        console.log("    -", m);
      }
    }
  }
}

main().catch(console.error);
