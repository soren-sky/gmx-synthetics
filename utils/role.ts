import { hashString } from "./hash";
import hre from "hardhat";
import { executeWithRetry } from "./deploy";

export async function grantRole(roleStore, account, role) {
  await roleStore.grantRole(account, hashString(role));
}

export async function revokeRole(roleStore, account, role) {
  await roleStore.revokeRole(account, hashString(role));
}

export async function grantRoleIfNotGranted(deployedContract, role: string, addressLabel = "") {
  if (hre.gmx.isExistingMainnetDeployment) {
    return;
  }

  const { address } = deployedContract;
  const { deployments, getNamedAccounts } = hre;
  const { read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log(`grantRoleIfNotGranted: ${deployedContract.contractName}, ${role}`);

  const roleHash = hashString(role);
  const hasRole = await read("RoleStore", "hasRole", address, roleHash);

  if (!hasRole) {
    log("granting role %s to %s %s", role, addressLabel, address);

    await executeWithRetry(
      () => execute("RoleStore", { from: deployer, log: true, waitConfirmations: 2 }, "grantRole", address, roleHash),
      `grantRole ${role}`,
      log
    );
  } else {
    log("role %s already granted to %s %s", role, addressLabel, address);
  }
}

export async function revokeRoleIfGranted(contract, role: string, addressLabel = "") {
  if (hre.gmx.isExistingMainnetDeployment) {
    return;
  }

  const { address } = contract;
  const { deployments, getNamedAccounts } = hre;
  const { read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const roleHash = hashString(role);
  const hasRole = await read("RoleStore", "hasRole", address, roleHash);

  if (hasRole) {
    log("revoking role %s for %s %s", role, addressLabel, address);

    await executeWithRetry(
      () => execute("RoleStore", { from: deployer, log: true, waitConfirmations: 2 }, "revokeRole", address, roleHash),
      `revokeRole ${role}`,
      log
    );
  } else {
    log("role %s already revoked for %s %s", role, addressLabel, address);
  }
}
