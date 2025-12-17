const { ethers } = require("hardhat");
const keys = require("../utils/keys");

async function main() {
    const glvAddress = "0xFe495DBF2dd137b2266f56425B97f09ce0CDEF41";
    const key = keys.glvShiftMaxPriceImpactFactorKey(glvAddress);
    
    const dataStore = await ethers.getContract("DataStore");
    const value = await dataStore.getUint(key);
    
    console.log("当前 GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR 值:", value.toString());
    console.log("对应百分比:", ethers.utils.formatUnits(value, 16) + "%");
    
    // 检查我们之前可能设置的错误 key
    console.log("\n检查可能的错误 key...");
    
    // 错误的 key 计算方式（keccak256 of string directly）
    const wrongKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address"],
            [ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR")), glvAddress]
        )
    );
    const wrongValue = await dataStore.getUint(wrongKey);
    console.log("错误 key 的值:", wrongValue.toString());
}

main();
