import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet:", wallet.address);

  const wbnb = await ethers.getContractAt(
    ["function withdraw(uint256)", "function balanceOf(address) view returns (uint256)"],
    "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    wallet
  );

  const balance = await wbnb.balanceOf(wallet.address);
  console.log("WBNB balance:", ethers.utils.formatEther(balance), "WBNB");

  if (balance.gt(0)) {
    console.log("Unwrapping all WBNB to BNB...");
    const tx = await wbnb.withdraw(balance);
    await tx.wait();
    console.log("Done! TX:", tx.hash);
  } else {
    console.log("No WBNB to unwrap");
  }

  const bnbBalance = await wallet.getBalance();
  console.log("New BNB balance:", ethers.utils.formatEther(bnbBalance), "BNB");
}

main().catch(console.error);
