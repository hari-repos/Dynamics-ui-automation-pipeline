@SalesModule
Feature: Sales Hub - Lead Qualification

  @persona:SalesManager @Smoke
  Scenario: Qualify a new lead as Sales Manager
    Given I navigate to D365 Sales Hub
    When I open the lead management section
    Then I should see the active lead list

  @persona:CustomerServiceAgent
  Scenario: View lead details as Customer Service Agent
    Given I navigate to D365 Sales Hub
    Then I should see the read-only lead dashboard
