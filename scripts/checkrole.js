const { ethers } = require("hardhat");

async function main() {
    const roleStore = await ethers.getContract("RoleStore");
    const deployer = "0xCD694Bb0e8a51E02696cE074396B4212E01Ec079";
    
    // Check CONTROLLER role
    const CONTROLLER = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], ["CONTROLLER"]));
    const hasController = await roleStore.hasRole(deployer, CONTROLLER);
    console.log("deployer 有 CONTROLLER 角色:", hasController);
    
    // Check CONFIG_KEEPER role
    const CONFIG_KEEPER = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], ["CONFIG_KEEPER"]));
    const hasConfigKeeper = await roleStore.hasRole(deployer, CONFIG_KEEPER);
    console.log("deployer 有 CONFIG_KEEPER 角色:", hasConfigKeeper);
    
    // 检查 DataStore 的所有者/权限
    const dataStore = await ethers.getContract("DataStore");
    const dsRoleStore = await dataStore.roleStore();
    console.log("\nDataStore 的 RoleStore:", dsRoleStore);
}

main();
