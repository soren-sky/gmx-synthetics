const { ethers } = require("hardhat");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    
    // GLV address
    const glvAddress = "0xFe495DBF2dd137b2266f56425B97f09ce0CDEF41";
    
    // Key for GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
    const GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address"],
            [
                ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR")),
                glvAddress
            ]
        )
    );
    
    const value = await dataStore.getUint(GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR);
    console.log("GLV:", glvAddress);
    console.log("GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR key:", GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR);
    console.log("Value:", value.toString());
    console.log("Value (%):", ethers.utils.formatUnits(value, 16) + "%");
}

main().catch(console.error);
