import { ethers } from "hardhat";
import * as keys from "./utils/keys";

async function main() {
  const glvAddress = "0xFe495DBF2dd137b2266f56425B97f09ce0CDEF41";
  const key = keys.glvShiftMaxPriceImpactFactorKey(glvAddress);
  console.log("Key from keys.ts:", key);

  const dataStore = await ethers.getContract("DataStore");
  const value = await dataStore.getUint(key);
  console.log("Value:", value.toString());
  console.log("Value (percent):", ethers.utils.formatUnits(value, 16) + "%");
}

main().catch(console.error);
