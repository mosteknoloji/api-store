// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 5"
"phantombuster dependencies: lib-StoreUtilities.js, lib-Instagram.js"

const Buster = require("phantombuster")
const buster = new Buster()

const Nick = require("nickjs")
const nick = new Nick({
	loadImages: true,
	printPageErrors: false,
	printResourceErrors: false,
	printNavigation: false,
	printAborts: false,
	debug: false,
})

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)
const Instagram = require("./lib-Instagram")
const instagram = new Instagram(nick, buster, utils)

let followSuccessCount = 0
let followRequestCount = 0
let rateLimited
// }

const getUrlsToScrape = (data, numberOfProfilesPerLaunch) => {
	data = data.filter((item, pos) => data.indexOf(item) === pos)
	const maxLength = data.length
	if (maxLength === 0) {
		utils.log("Input spreadsheet is empty OR we already scraped all the profiles from this spreadsheet.", "warning")
		nick.exit()
	}
	return data.slice(0, Math.min(numberOfProfilesPerLaunch, maxLength)) // return the first elements
}

// detecting rate limit
const interceptInstagramApiCalls = e => {
	if (e.response.url.indexOf("web/friendships") > -1 && e.response.status === 403) {
			rateLimited = true
	}
}

// function to follow a profile
const followProfile = async (tab, tabJson, query, profileUrl) => {
	const scrapedData = await instagram.scrapeProfile(tabJson, query, profileUrl)
	if (scrapedData.status === "Following") {
		utils.log(`You already follow ${scrapedData.profileName}!`, "warning")
		scrapedData.error = "Already following"
		return scrapedData
	}
	if (scrapedData.requestedByViewer === "Requested") {
		utils.log(`You already sent a request to ${scrapedData.profileName}!`, "warning")
		scrapedData.error = "Already requested"
		return scrapedData
	}
	if (scrapedData.status === "Blocked") {
		utils.log(`Can't follow ${scrapedData.profileName} as you blocked their profile!`, "warning")
		scrapedData.error = "Blocking"
		return scrapedData
	}
	await tab.click("main section button")
	await tab.wait(2000)
	const checkFollowData = await instagram.scrapeProfile(tabJson, query, profileUrl)
	if (checkFollowData.status === "Following") {
		utils.log(`Successfully followed ${checkFollowData.profileName}.`, "done")
		checkFollowData.followAction = "Success"
		followSuccessCount++
		return checkFollowData
	} else if (checkFollowData.requestedByViewer === "Requested") {
		utils.log(`Private account, successfully sent a request to ${checkFollowData.profileName}.`, "done")
		checkFollowData.followAction = "Request"
		followRequestCount++
		return checkFollowData
	} else {
		utils.log(`Fail to follow ${checkFollowData.profileName}!`, "warning")
		return null
	}
}

// Main function that execute all the steps to launch the scrape and handle errors
;(async () => {
	let { sessionCookie, spreadsheetUrl, columnName, numberOfProfilesPerLaunch , csvName } = utils.validateArguments()
	if (!csvName) { csvName = "result" }
	let urls, result
	if (spreadsheetUrl.toLowerCase().includes("instagram.com/")) { // single instagram url
		urls = instagram.cleanInstagramUrl(utils.adjustUrl(spreadsheetUrl, "instagram"))
		if (urls) {	
			urls = [ urls ]
		} else {
			utils.log("The given url is not a valid instagram profile url.", "error")
		}
		result = []
	} else { // CSV
		urls = await utils.getDataFromCsv(spreadsheetUrl, columnName)
		urls = urls.filter(str => str) // removing empty lines
		for (let i = 0; i < urls.length; i++) { // cleaning all instagram entries
			urls[i] = utils.adjustUrl(urls[i], "instagram")
			urls[i] = instagram.cleanInstagramUrl(urls[i])
		}
		if (!numberOfProfilesPerLaunch) {
			numberOfProfilesPerLaunch = urls.length
		}
		result = await utils.getDb(csvName + ".csv")
		urls = getUrlsToScrape(urls.filter(el => utils.checkDb(el, result, "query")), numberOfProfilesPerLaunch)
	}
	followSuccessCount = result.filter(el => el.followAction === "Success").length
	followRequestCount = result.filter(el => el.followAction === "Request").length
	console.log(`URLs to scrape: ${JSON.stringify(urls, null, 4)}`)
	const tab = await nick.newTab()
	const jsonTab = await nick.newTab()
	await instagram.login(tab, sessionCookie)

	let pageCount = 0
	tab.driver.client.on("Network.responseReceived", interceptInstagramApiCalls)

	for (let url of urls) {
		const timeLeft = await utils.checkTimeLeft()
		if (!timeLeft.timeLeft) {
			utils.log(`Scraping stopped: ${timeLeft.message}`, "warning")
			break
		}
		try {
			utils.log(`Opening page ${url}`, "loading")
			pageCount++
			buster.progressHint(pageCount / urls.length, `${pageCount} profile${pageCount > 1 ? "s" : ""} scraped`)
			await tab.open(url)
			const selected = await tab.waitUntilVisible(["main", ".error-container"], 15000, "or")
			if (selected === ".error-container") {
				utils.log(`Couldn't open ${url}, broken link or page has been removed.`, "warning")
				result.push({ query: url, error: "Broken link or page has been removed" })
				continue
			}
			const profileUrl = await tab.getUrl()
			const tempResult = await followProfile(tab, jsonTab, url, profileUrl)
			if (tempResult) {
				result.push(tempResult)
			}
			utils.log(`In total ${followSuccessCount} profiles followed, ${followRequestCount} requests sent.`, "done")
		} catch (err) {
			utils.log(`Can't scrape the profile at ${url} due to: ${err.message || err}`, "warning")
			continue
		}
		if (rateLimited) {
			utils.log("Rate limited by Instagram, stopping the agent... Please retry later.", "warning")
			break
		}
		await tab.wait(1500 + Math.random() * 2000)
	}
	tab.driver.client.removeListener("Network.responseReceived", interceptInstagramApiCalls)

	await utils.saveResults(result, result, csvName)
	nick.exit(0)
})()
.catch(err => {
	utils.log(err, "error")
	nick.exit(1)
})
