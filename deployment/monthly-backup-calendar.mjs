/** Prepare the existing Mac's mechanical monthly timer. Does not install or start it. */
import { isAbsolute, join } from "node:path";
import { validateMonthlyRuntimeConfiguration } from "./monthly-backup-runtime.mjs";

const requireValue=(value,reason)=>{if(!value)throw new Error(reason);};
const escape=value=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export function buildMonthlyLaunchAgent(config,{nodePath,runtimePath,configPath,home,hostTimezone}={}) {
  validateMonthlyRuntimeConfiguration(config);
  requireValue([nodePath,runtimePath,configPath,home].every(path=>typeof path==="string" && isAbsolute(path) && !/[\0\r\n]/.test(path)) &&
    hostTimezone===config.timezone,"monthly_calendar_host_or_path_invalid");
  const label=`org.virtualmente.yenhubs.monthly.${config.instanceId}`;
  const paths=[join(home,".node/bin"),join(home,".local/bin"),"/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin","/usr/sbin","/sbin"];
  requireValue(!paths.some(path=>path.includes(":")),"monthly_calendar_path_invalid");
  const args=[nodePath,runtimePath,"--config",configPath,"--mode","scheduled"];
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escape(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg=>`<string>${escape(arg)}</string>`).join("")}</array>
<key>StartCalendarInterval</key><dict><key>Day</key><integer>1</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(paths.join(":"))}</string><key>TZ</key><string>Europe/Madrid</string></dict>
<key>StandardOutPath</key><string>${escape(join(config.stateRoot,"calendar.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escape(join(config.stateRoot,"calendar.stderr.log"))}</string>
</dict></plist>\n`;
  return {schema:"yenhubs-monthly-calendar-plan-v1",state:"prepared-not-installed",label,xml,
    schedule:{day:1,hour:3,minute:0,timezone:config.timezone},configurationEnabled:config.schedule.enabled,
    requirements:{machineAvailable:true,ownerLoggedIn:true,exactFinalCode:true,independentKeyCustody:true,isolatedRestores:true},
    // Launch at login catches a missed month without creating a second monthly attempt.
    // It is not an always-on cloud scheduler or a guarantee for months the Mac never runs.
    backupAutoretry:false,modelCallsPerRun:0};
}
