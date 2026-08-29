"use strict";

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed(interaction) {
  if (ALLOWED_USER_IDS.length === 0 && ALLOWED_ROLE_IDS.length === 0) return true;
  if (ALLOWED_USER_IDS.includes(interaction.user.id)) return true;
  const memberRoles = interaction.member && interaction.member.roles && interaction.member.roles.cache;
  if (memberRoles && ALLOWED_ROLE_IDS.some((r) => memberRoles.has(r))) return true;
  return false;
}

function isAdmin(interaction) {
  if (ADMIN_USER_IDS.length === 0) return false;
  return ADMIN_USER_IDS.includes(interaction.user.id);
}

module.exports = { isAllowed, isAdmin, ALLOWED_USER_IDS, ALLOWED_ROLE_IDS, ADMIN_USER_IDS };
