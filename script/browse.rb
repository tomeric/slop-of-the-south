# Headless check of the running game: loads a URL in headless Chrome (selenium-webdriver from the test group), runs a
# script against window.slop and saves a screenshot. Handy when no browser automation is at hand.
#   mise x -- bundle exec ruby script/browse.rb "http://192.168.68.61:3000/?time=13&name=Tester" 10 "$(cat check.js)" shot.png
# The script gets the async callback as its last argument (`arguments[arguments.length - 1]`) and must call it.
require "selenium-webdriver"
require "json"

# headless Chrome driver for the game: browse.rb URL WAIT_SECONDS [JS] [SCREENSHOT_PATH]
url, wait, js, shot = ARGV
opts = Selenium::WebDriver::Chrome::Options.new
%w[--headless=new --window-size=1400,900 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
   --autoplay-policy=no-user-gesture-required --mute-audio --disable-gpu-vsync].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
driver = Selenium::WebDriver.for(:chrome, options: opts)
driver.manage.timeouts.script_timeout = 120
begin
  driver.navigate.to(url)
  sleep(wait.to_f)
  if js && !js.empty?
    result = driver.execute_async_script(js)
    puts JSON.pretty_generate(result)
  end
  File.binwrite(shot, driver.screenshot_as(:png)) if shot && !shot.empty?
  logs = driver.logs.get(:browser).reject { _1.message.include?("favicon") }
  puts "--- console (#{logs.size}):"
  logs.first(20).each { puts "#{_1.level} #{_1.message[0, 300]}" }
ensure
  driver.quit
end
