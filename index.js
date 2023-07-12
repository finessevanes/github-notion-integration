/* ================================================================================

	notion-github-sync.
  
  Glitch example: https://glitch.com/edit/#!/notion-github-sync
  Find the official Notion API client @ https://github.com/makenotion/notion-sdk-js/

================================================================================ */

const { Client } = require("@notionhq/client");
const dotenv = require("dotenv");
const { Octokit } = require("octokit");
const _ = require("lodash");

dotenv.config();
const octokit = new Octokit({ auth: process.env.GITHUB_KEY });
const notion = new Client({ auth: process.env.NOTION_KEY });

const databaseId = process.env.NOTION_DATABASE_ID;
const OPERATION_BATCH_SIZE = 10;

/**
 * Local map to store  GitHub issue ID to its Notion pageId.
 * { [issueId: string]: string }
 */
const gitHubIssuesIdToNotionPageId = {};

/**
 * Initialize local data store.
 * Then sync with GitHub.
 */
setInitialGitHubToNotionIdMap().then(syncNotionDatabaseWithGitHub);

/**
 * Get and set the initial data store with issues currently in the database.
 */
async function setInitialGitHubToNotionIdMap() {
  const currentIssues = await getIssuesFromNotionDatabase();
  for (const { pageId, issueNumber } of currentIssues) {
    gitHubIssuesIdToNotionPageId[issueNumber] = pageId;
  }
}

async function syncNotionDatabaseWithGitHub() {
  // Get all issues currently in the provided GitHub repository.
  console.log("\nFetching issues from GitHub repository...");
  const issues = await getGitHubIssuesForRepository();
  console.log(`Fetched ${issues.length} issues from GitHub repository.`);

  // Group issues into those that need to be created or updated in the Notion database.
  const { pagesToCreate, pagesToUpdate } = getNotionOperations(issues);

  // Create pages for new issues.
  console.log(`\n${pagesToCreate.length} new issues to add to Notion.`);
  await createPages(pagesToCreate);

  // Updates pages for existing issues.
  console.log(`\n${pagesToUpdate.length} issues to update in Notion.`);
  await updatePages(pagesToUpdate);

  // Success!
  console.log("\n✅ Notion database is synced with GitHub.");
}

/**
 * Gets pages from the Notion database.
 *
 * @returns {Promise<Array<{ pageId: string, issueNumber: number }>>}
 */
async function getIssuesFromNotionDatabase() {
  const pages = [];
  let cursor = undefined;
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }
  console.log(`${pages.length} issues successfully fetched.`);

  const issues = [];
  for (const page of pages) {
    const issueNumberPropertyId = page.properties["Issue Number"].id;
    const propertyResult = await notion.pages.properties.retrieve({
      page_id: page.id,
      property_id: issueNumberPropertyId,
    });
    issues.push({
      pageId: page.id,
      issueNumber: propertyResult.number,
    });
  }

  return issues;
}

/**
 * Gets issues from a GitHub repository. Pull requests are omitted.
 *
 * https://docs.github.com/en/rest/guides/traversing-with-pagination
 * https://docs.github.com/en/rest/reference/issues
 *
 * @returns {Promise<Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string, follow_up: boolean }>>}
 */
async function getGitHubIssuesForRepository() {
  const issues = [];
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: process.env.GITHUB_REPO_NAME,
    state: "open",
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const issue of data) {
      if (!issue.pull_request) {
        const comments = await octokit.rest.issues.listComments({
          owner: process.env.GITHUB_REPO_OWNER,
          repo: process.env.GITHUB_REPO_NAME,
          issue_number: issue.number,
          per_page: 1, // We only need the last comment
          direction: 'desc' // Ensure the last comment
        });
        let follow_up = false; // Default to false
        const assignee = issue.assignee ? issue.assignee.login : 'None';
        if (comments.data.length === 0) { // If no comments, set follow_up to true
          follow_up = true;
        } else { // If there are comments
          const lastComment = comments.data[0];
          console.log('#############################################')
          console.log(`issue: ${issue.number}: author_association: ${lastComment.author_association}, last comment by: ${lastComment.user.login}`)
          console.log('#############################################')


          if (lastComment.author_association === "COLLABORATOR" || lastComment.author_association === "OWNER" || lastComment.author_association === "MEMBER") {
            follow_up = false;
          }
        }
        issues.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          comment_count: issue.comments,
          url: issue.html_url,
          labels: issue.labels,
          follow_up: follow_up,
          assignee: assignee
        });
      }
    }
  }
  return issues;
}


/**
 * Determines which issues already exist in the Notion database.
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} issues
 * @returns {{
 *   pagesToCreate: Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>;
 *   pagesToUpdate: Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>
 * }}
 */
function getNotionOperations(issues) {
  const pagesToCreate = [];
  const pagesToUpdate = [];
  for (const issue of issues) {
    const pageId = gitHubIssuesIdToNotionPageId[issue.number];
    if (pageId) {
      pagesToUpdate.push({
        ...issue,
        pageId,
      });
    } else {
      pagesToCreate.push(issue);
    }
  }
  return { pagesToCreate, pagesToUpdate };
}

/**
 * Creates new pages in Notion.
 *
 * https://developers.notion.com/reference/post-page
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToCreate
 */
async function createPages(pagesToCreate) {
  const pagesToCreateChunks = _.chunk(pagesToCreate, OPERATION_BATCH_SIZE);
  for (const pagesToCreateBatch of pagesToCreateChunks) {
    await Promise.all(
      pagesToCreateBatch.map((issue) =>
        notion.pages.create({
          parent: { database_id: databaseId },
          properties: getPropertiesFromIssue(issue),
        })
      )
    );
    console.log(`Completed batch size: ${pagesToCreateBatch.length}`);
  }
}

/**
 * Updates provided pages in Notion.
 *
 * https://developers.notion.com/reference/patch-page
 *
 * @param {Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToUpdate
 */
async function updatePages(pagesToUpdate) {
  const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE);
  for (const pagesToUpdateBatch of pagesToUpdateChunks) {
    await Promise.all(
      pagesToUpdateBatch.map(({ pageId, ...issue }) =>
        notion.pages.update({
          page_id: pageId,
          properties: getPropertiesFromIssue(issue),
        })
      )
    );
    console.log(`Completed batch size: ${pagesToUpdateBatch.length}`);
  }
}

//*========================================================================
// Helpers
//*========================================================================

/**
 * Returns the GitHub issue to conform to this database's schema properties.
 *
 * @param {{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string, labels: string }} issue
 */
function getPropertiesFromIssue(issue) {
  const { title, number, state, comment_count, url, labels, follow_up, assignee } = issue;
  console.log('GET PROPERTIES FROM ISSUE')
  console.log(`Issue number: ${number}, follow_up: ${follow_up}`);
  return {
    Name: {
      title: [{ type: "text", text: { content: title } }],
    },
    "Issue Number": {
      number,
    },
    State: {
      select: { name: state },
    },
    "Number of Comments": {
      number: comment_count,
    },
    "Issue URL": {
      url,
    },
    "Labels": {
      multi_select: labels.map((label) => ({ name: label.name })),
    },
    "Follow Up": {
      select: { name: follow_up ? 'true' : 'false' },
    },
    "Assignee": {
      rich_text: [{ type: "text", text: { content: assignee } }],
    },
  };
}

/**
 * Gets the collaborators from a GitHub repository.
 *
 * https://docs.github.com/en/rest/reference/repos#list-repository-collaborators
 *
 * @returns {Promise<Set<string>>}
 */
async function getGitHubCollaborators() {
  const collaborators = new Set();
  const iterator = octokit.paginate.iterator(octokit.rest.repos.listCollaborators, {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: process.env.GITHUB_REPO_NAME,
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const collaborator of data) {
      collaborators.add(collaborator.login);
    }
  }
  return collaborators;
}